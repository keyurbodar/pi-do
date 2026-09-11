// stream-pack.test.mjs — pins the buffered chunk-packing path in
// worker/src/stream-codec.ts as live write-pressure mitigation, against the
// proposed trim (BufferedChunk import dead, no write-pressure evidence).
//
// Trigger under test: emitEntry buffers instead of INSERTing when the turn
// has an armed chunk cursor and the frame is a free-text streaming delta
// (type "text" or "thinking" with the { runId, delta } shape that
// stream-engine's onUpdate pushes for every LLM delta). The buffer flushes
// as one multi-row INSERT on the next structural frame or when the row
// budget (16) trips — so a turn streaming hundreds of deltas does a handful
// of chunk INSERTs while every entry row still persists per emit.
import test from "node:test";
import assert from "node:assert/strict";
import { emitEntry } from "../src/stream-codec.ts";

// In-memory EntriesSql fake: serves exactly the query shapes emitEntry's
// callees issue (entries insert/select, leaf, last_insert_rowid, chunk
// inserts, pi_runs touch) and records every pi_chunks INSERT with its row
// count so the tests observe batching instead of internals.
function makeSql() {
  const state = {
    nextId: 1,
    entries: [],
    leaf: new Map(),
    chunks: [],
    chunkInserts: [],
    runsTouched: 0,
  };
  const sql = {
    state,
    exec(query, ...b) {
      if (query.startsWith("INSERT INTO pi_entries")) {
        const id = state.nextId++;
        state.entries.push({ id, sid: b[0], parent: b[1], type: b[2], body: b[3] });
        return [];
      }
      if (query.startsWith("SELECT last_insert_rowid")) return [{ id: state.nextId - 1 }];
      if (query.startsWith("SELECT leaf FROM sessions")) {
        return state.leaf.has(b[0]) ? [{ leaf: state.leaf.get(b[0]) }] : [];
      }
      if (query.startsWith("UPDATE sessions SET leaf")) {
        state.leaf.set(b[1], b[0]);
        return [];
      }
      if (query.startsWith("SELECT id AS cursor")) {
        const rows = state.entries
          .filter((e) => e.sid === b[0])
          .filter((e) => (query.includes("AND id > ?") ? e.id > b[1] : e.id === b[1]))
          .sort((x, y) => x.id - y.id);
        const limited = query.includes("LIMIT ?") ? rows.slice(0, b[b.length - 1]) : rows;
        return limited.map((e) => ({ cursor: e.id, parent: e.parent, type: e.type, body: e.body }));
      }
      if (query.startsWith("SELECT COUNT(*) AS count")) {
        const ids = state.entries.filter((e) => e.sid === b[0]).map((e) => e.id);
        return [{ count: ids.length, head: ids.length === 0 ? 0 : Math.max(...ids) }];
      }
      if (query.startsWith("INSERT INTO pi_chunks")) {
        const groups = query.split("(?, ?, ?, ?, ?)").length - 1;
        assert.ok(groups >= 1, `chunk insert must carry row placeholders: ${query}`);
        const rows = [];
        for (let i = 0; i < groups; i++) {
          const slice = b.slice(i * 5, i * 5 + 5);
          rows.push({ sid: slice[0], turnId: slice[1], seq: slice[2], body: slice[3], cursor: slice[4] });
        }
        state.chunks.push(...rows);
        state.chunkInserts.push({ rowCount: groups });
        return [];
      }
      if (query.startsWith("UPDATE pi_runs SET updatedAt")) {
        state.runsTouched++;
        return [];
      }
      throw new Error(`fake sql: unexpected query ${query}`);
    },
  };
  return sql;
}

function makeHost(sql, sid = "s1") {
  return {
    sql,
    ws: "ws1",
    sid,
    live: new Map([
      [sid, { controller: new AbortController(), chunkTurn: { turnId: "t1", seq: 0 }, chunkBuf: [] }],
    ]),
    sockets: () => [],
  };
}

function makeSock() {
  return { sent: [], closed: [], send(f) { this.sent.push(f); }, close(c, r) { this.closed.push([c, r]); } };
}

test("text/thinking deltas buffer with zero chunk INSERTs, then flush as one batch on a structural frame", () => {
  const sql = makeSql();
  const host = makeHost(sql);
  const sock = makeSock();

  // The exact producer shape: stream-engine onUpdate pushes one
  // ("text"|"thinking", { runId, delta }) pair per LLM streaming delta.
  for (let i = 0; i < 4; i++) emitEntry(host, sock, "text", { runId: "r1", delta: `tok${i} ` });
  emitEntry(host, sock, "thinking", { runId: "r1", delta: "hmm " });

  // Persist-before-emit holds per entry, but no chunk row is written yet:
  // five deltas, zero pi_chunks INSERTs. That gap IS the write-pressure win.
  assert.equal(sql.state.entries.length, 5);
  assert.equal(sql.state.chunkInserts.length, 0);
  assert.equal(host.live.get("s1").chunkBuf.length, 5);

  // A structural frame pins its own row and flushes the buffer in the same
  // transaction: one multi-row INSERT carrying all six rows.
  emitEntry(host, sock, "toolCall", { runId: "r1", id: "c1", tool: "read", args: { path: "seed.txt" } });
  assert.equal(sql.state.entries.length, 6);
  assert.equal(sql.state.chunkInserts.length, 1);
  assert.deepEqual(sql.state.chunkInserts[0], { rowCount: 6 });

  const chunks = sql.state.chunks;
  assert.deepEqual(chunks.map((c) => c.seq), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(chunks.map((c) => c.turnId), ["t1", "t1", "t1", "t1", "t1", "t1"]);
  // Every chunk row pins its own entry cursor: entries and chunks land
  // together, so no delta can outlive or lag its entry.
  assert.deepEqual(chunks.map((c) => c.cursor), [1, 2, 3, 4, 5, 6]);
  assert.equal(chunks[0].body, JSON.stringify({ runId: "r1", delta: "tok0 " }));
  assert.equal(chunks[4].body, JSON.stringify({ runId: "r1", delta: "hmm " }));
  assert.equal(chunks[5].body, JSON.stringify({ runId: "r1", id: "c1", tool: "read", args: { path: "seed.txt" } }));

  // No failure path tripped: nothing sent to the socket, turn stays open.
  assert.equal(sock.sent.length, 0);
  assert.equal(sock.closed.length, 0);
  assert.equal(sql.state.runsTouched, 6);
});

test("the 16-row budget flushes a full text buffer mid-stream in one INSERT", () => {
  const sql = makeSql();
  const host = makeHost(sql);
  const sock = makeSock();

  for (let i = 0; i < 16; i++) emitEntry(host, sock, "text", { runId: "r1", delta: `tok${i} ` });
  assert.equal(sql.state.entries.length, 16);
  assert.equal(sql.state.chunkInserts.length, 0);

  // 17th delta trips `chunkBuf.length >= 16`: the whole buffer flushes as
  // one 17-row INSERT instead of seventeen per-delta INSERTs.
  emitEntry(host, sock, "text", { runId: "r1", delta: "tok16 " });
  assert.equal(sql.state.entries.length, 17);
  assert.equal(sql.state.chunkInserts.length, 1);
  assert.deepEqual(sql.state.chunkInserts[0], { rowCount: 17 });
  assert.deepEqual(sql.state.chunks.map((c) => c.seq), Array.from({ length: 17 }, (_, i) => i));
  assert.ok(sql.state.chunks.every((c) => typeof c.cursor === "number" && c.cursor >= 1));
  assert.equal(sock.sent.length, 0);
});
