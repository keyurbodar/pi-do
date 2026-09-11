// stream-codec.test.mjs — socket-level coverage for worker/src/stream-codec.ts.
// Uses in-memory socket doubles: no server, no network. Covers the paths
// stream-pack.test.mjs leaves unwired: wrapSocket frame build/parse,
// broadcast fan-out filtering, readAttachment malformed handling, rapid-delta
// coalescing as observed on the socket, buffered-vs-direct flush row shape,
// and the persist-failure close contract.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_UNKNOWN,
  broadcast,
  emitEntry,
  readAttachment,
  wrapSocket,
} from "../src/stream-codec.ts";

// Same EntriesSql fake as stream-pack.test.mjs: serves exactly the query
// shapes emitEntry's callees issue and records pi_chunks INSERT row counts.
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

// In-memory WebSocket double: captures raw strings like a real socket would
// carry them, and answers deserializeAttachment for the broadcast filter.
function makeWs(attachment, raw = []) {
  return {
    raw,
    sent: [],
    closed: [],
    send(s) {
      this.raw.push(s);
    },
    close(code, reason) {
      this.closed.push([code, reason]);
    },
    deserializeAttachment() {
      if (typeof attachment === "function") return attachment();
      return attachment;
    },
  };
}

function makeSock() {
  return {
    sent: [],
    closed: [],
    send(f) {
      this.sent.push(f);
    },
    close(c, r) {
      this.closed.push([c, r]);
    },
  };
}

function makeHost(sql, { sid = "s1", sockets = [] } = {}) {
  return {
    sql,
    ws: "ws1",
    sid,
    live: new Map([
      [sid, { controller: new AbortController(), chunkTurn: { turnId: "t1", seq: 0 }, chunkBuf: [] }],
    ]),
    sockets: () => sockets,
  };
}

test("wrapSocket builds a wire frame the peer parses back identically", () => {
  const ws = makeWs({ ws: "ws1", sid: "s1" });
  const frame = { entry: { cursor: 7, type: "text", body: { runId: "r1", delta: "héllo ✓" } } };
  wrapSocket(ws).send(frame);
  assert.equal(ws.raw.length, 1);
  assert.equal(typeof ws.raw[0], "string");
  assert.deepEqual(JSON.parse(ws.raw[0]), frame);
});

test("rapid text deltas coalesce with zero chunk INSERTs while the socket sees every entry in order", () => {
  const sql = makeSql();
  const ws = makeWs({ ws: "ws1", sid: "s1" });
  const host = makeHost(sql, { sockets: [ws] });
  const sock = makeSock();

  for (let i = 0; i < 10; i++) emitEntry(host, sock, "text", { runId: "r1", delta: `tok${i} ` });

  assert.equal(sql.state.entries.length, 10);
  assert.equal(sql.state.chunkInserts.length, 0);
  assert.equal(ws.raw.length, 10);
  const cursors = ws.raw.map((s) => JSON.parse(s).entry.cursor);
  assert.deepEqual(cursors, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Deltas arrive on the wire in emit order with no gaps or dupes (entry
  // bodies are stored serialized, so parse them before comparing).
  const wireBodies = ws.raw.map((s) => {
    const body = JSON.parse(s).entry.body;
    return typeof body === "string" ? JSON.parse(body) : body;
  });
  assert.deepEqual(
    wireBodies,
    Array.from({ length: 10 }, (_, i) => ({ runId: "r1", delta: `tok${i} ` })),
  );

  // The turn-boundary structural frame flushes the whole run as one batch
  // with gapless seq and one cursor per entry.
  emitEntry(host, sock, "toolCall", { runId: "r1", id: "c1", tool: "read", args: {} });
  assert.deepEqual(sql.state.chunkInserts, [{ rowCount: 11 }]);
  assert.deepEqual(sql.state.chunks.map((c) => c.seq), Array.from({ length: 11 }, (_, i) => i));
  assert.deepEqual(sql.state.chunks.map((c) => c.cursor), Array.from({ length: 11 }, (_, i) => i + 1));
});

test("buffered boundary flush writes the identical row shape as a direct live flush", () => {
  const direct = makeSql();
  const directHost = makeHost(direct);
  const directSock = makeSock();
  const body = { runId: "r9", id: "c9", tool: "write", args: { path: "a.txt" } };
  emitEntry(directHost, directSock, "toolCall", body);
  assert.deepEqual(direct.state.chunkInserts, [{ rowCount: 1 }]);

  const buffered = makeSql();
  const bufferedHost = makeHost(buffered);
  const bufferedSock = makeSock();
  emitEntry(bufferedHost, bufferedSock, "text", { runId: "r9", delta: "a" });
  emitEntry(bufferedHost, bufferedSock, "text", { runId: "r9", delta: "b" });
  emitEntry(bufferedHost, bufferedSock, "toolCall", body);
  assert.deepEqual(buffered.state.chunkInserts, [{ rowCount: 3 }]);

  const liveRow = direct.state.chunks[0];
  const boundaryRow = buffered.state.chunks[2];
  assert.deepEqual(Object.keys(boundaryRow).sort(), Object.keys(liveRow).sort());
  assert.equal(boundaryRow.turnId, liveRow.turnId);
  assert.equal(boundaryRow.body, liveRow.body);
  assert.equal(boundaryRow.body, JSON.stringify(body));
});

test("broadcast reaches only the matching session socket and survives a throwing peer", () => {
  const sql = makeSql();
  const mine = makeWs({ ws: "ws1", sid: "s1" });
  const otherSid = makeWs({ ws: "ws1", sid: "s2" });
  const otherWs = makeWs({ ws: "ws2", sid: "s1" });
  const noAtt = makeWs(null);
  const bad = makeWs({});
  const throwing = makeWs({ ws: "ws1", sid: "s1" });
  throwing.send = () => {
    throw new Error("dead peer");
  };
  const host = makeHost(sql, { sockets: [mine, otherSid, otherWs, noAtt, bad, throwing] });
  broadcast(host, { entry: { cursor: 1 } });
  assert.equal(mine.raw.length, 1);
  assert.deepEqual(JSON.parse(mine.raw[0]), { entry: { cursor: 1 } });
  for (const ws of [otherSid, otherWs, noAtt, bad]) assert.equal(ws.raw.length, 0);
});

test("malformed attachments read as null and a failing socket never throws", () => {
  for (const att of [null, undefined, 42, "x", [], {}, { ws: "" }, { sid: "" }, { ws: "a" }, { sid: "b" }]) {
    assert.equal(readAttachment(makeWs(att)), null);
  }
  assert.equal(
    readAttachment(makeWs(() => {
      throw new Error("no attachment");
    })),
    null,
  );
  assert.deepEqual(readAttachment(makeWs({ ws: "ws1", sid: "s1", extra: 1 })), { ws: "ws1", sid: "s1" });

  const dead = { send() { throw new Error("gone"); }, close() { throw new Error("gone"); } };
  assert.doesNotThrow(() => wrapSocket(dead).send({ entry: 1 }));
  assert.doesNotThrow(() => wrapSocket(dead).close(4403, "fenced"));
});

test("wrapSocket truncates long close reasons to the 120-char wire cap", () => {
  const ws = makeWs({ ws: "ws1", sid: "s1" });
  wrapSocket(ws).close(4403, `${"r".repeat(200)}`);
  assert.deepEqual(ws.closed, [[4403, "r".repeat(120)]]);
  wrapSocket(ws).close(4403, "short");
  assert.deepEqual(ws.closed[1], [4403, "short"]);
});

test("a persist failure reports on the socket, closes 4404, and orphans the turn", () => {
  const sql = makeSql();
  sql.exec = () => {
    throw new Error("disk full");
  };
  const host = makeHost(sql);
  const sock = makeSock();
  emitEntry(host, sock, "text", { runId: "r1", delta: "x" });
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].error, /disk full/);
  assert.equal(sock.sent[0].hint, "chunk persist failed; the turn is orphaned and the recovery scan will redrive it");
  assert.equal(sock.closed.length, 1);
  assert.equal(sock.closed[0][0], CLOSE_UNKNOWN);
  assert.equal(host.live.has("s1"), false);
});
