// redrive-identity.test.mjs — pins two stream-engine finishes.
// 1. A mid-turn concurrent-rotation conflict carries the live fence id (like
//    the 403/409 bodies) so a fenced-out holder can re-claim; error string
//    and close code stay byte-identical.
// 2. Redrive run identity: the pi_runs ledger row, the chunk namespace, and
//    the emitted entry runIds reuse the original turnId, while the runs-table
//    row stays keyed by the fresh runId minted at open (redrive opens no runs
//    row, so closeRun(turnId) matches nothing). Drives the real engine over
//    DatabaseSync stores with the stub model; no mocks.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";

const { ensureEpisodeSchema } = await import("pi-cf/store/episode");
const { ensureWorkspaceSchema } = await import("pi-cf/store/sql-util");
const { appendChunk, ensureChunksSchema, listChunksForTurn } = await import("pi-cf/store/chunks");
const { appendEntry, ensureEntriesSchema, entryHead, listEntries, openRun } = await import("pi-cf/store/entries");
const { ensureRunsSchema, getPiRun, openPiRun } = await import("pi-cf/store/runs");
const engine = await import("../src/stream-engine.ts");
const { CLOSE_CONFLICT } = await import("../src/stream-codec.ts");
const { ensureCompactionSchema } = await import("../src/compaction.ts");

function makeSql(db) {
  const sql = {
    exec(query, ...bindings) {
      const text = String(query);
      const stmt = db.prepare(text);
      if (/^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(text)) return stmt.all(...bindings);
      stmt.run(...bindings);
      return [];
    },
    transactionSync(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        fn();
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      db.exec("COMMIT");
    },
  };
  ensureWorkspaceSchema(sql);
  ensureEntriesSchema(sql);
  ensureEpisodeSchema(sql);
  ensureRunsSchema(sql);
  ensureChunksSchema(sql);
  ensureCompactionSchema(sql);
  return sql;
}

function openDb() {
  const db = new DatabaseSync(":memory:");
  return { db, sql: makeSql(db) };
}

// Inline session queue, live fence holder, stub runtime. casRotateFence is
// injectable: false simulates a concurrent holder rotating mid-turn.
function makeHost(sql, sid = "s1", casRotateFence = () => true) {
  return {
    sql,
    ws: "ws1",
    sid,
    files: { get: (_ws, path) => (path === "seed.txt" ? new TextEncoder().encode("seed") : undefined), put: () => 0, list: () => [], remove: () => false },
    shell: { exec: async () => ({ stdout: "", stderr: "", exit: 0, timedOut: false }) },
    runtimeEnv: {},
    thinking: null,
    retention: "short",
    model: null,
    workspaceKnown: true,
    sessionKnown: true,
    readFence: () => ({ fence: "f-live", revision: 7 }),
    casRotateFence,
    live: new Map(),
    sockets: () => [],
    enqueue: (fn) => fn(),
    scheduleAlarm: async () => {},
    pokeAlarm: async () => {},
    holdKeepalive: async () => {},
    releaseKeepalive: async () => {},
  };
}

function collectSock() {
  return {
    sent: [],
    closed: [],
    send(frame) { this.sent.push(frame); },
    close(code, reason) { this.closed.push([code, reason]); },
  };
}

function bodyOf(entry) {
  return typeof entry.body === "string" ? JSON.parse(entry.body) : entry.body;
}

test("mid-turn concurrent rotation carries the live fence for re-claim", async () => {
  const { db, sql } = openDb();
  try {
    const host = makeHost(sql, "s1", () => false);
    const sock = collectSock();
    await engine.socketMessage(host, sock, JSON.stringify({ prompt: "hi", fence: "f-live", expected: 7 }));
    const frame = sock.sent.at(-1);
    assert.equal(frame.error, "revision conflict");
    assert.equal(frame.hint, "a concurrent holder rotated mid-turn; re-claim and retry");
    assert.equal(frame.revision, 7);
    assert.equal(frame.fence, "f-live");
    assert.deepEqual(sock.closed, [[CLOSE_CONFLICT, "concurrent rotation mid-turn"]]);
    assert.equal(sock.closed[0][0], 4409);
  } finally {
    db.close();
  }
});

test("redrive reuses turnId for ledger, chunks, entries; runs row keeps the fresh runId", async () => {
  const { db, sql } = openDb();
  try {
    // Crashed client turn as startTurn left it: ledger + runs rows open under
    // distinct ids, prompt committed under the fresh runId, chunk seq 0 taken.
    openPiRun(sql, "s1", "t-orig", "f-live", 0);
    openRun(sql, "s1", "r-fresh");
    const promptCursor = appendEntry(sql, "s1", "prompt", { runId: "r-fresh", prompt: "hi" });
    appendChunk(sql, "s1", "t-orig", 0, { runId: "r-fresh", prompt: "hi" }, promptCursor);
    const host = makeHost(sql);
    await engine.redriveTurn(
      host,
      { sid: "s1", turnId: "t-orig", fence: "f-live", cursor: 0, prompt: "hi", suffix: [], resume: [], nextSeq: 1, fresh: false, skipDeltas: 1 },
    );
    // Ledger row closed via executeTurn's done wrapper.
    assert.equal(getPiRun(sql, "t-orig"), null);
    // Runs table: no row under the turnId; the fresh open row survives for a
    // later client open to sweep to interrupted.
    const runs = sql.exec("SELECT runId, status FROM runs WHERE sid = ?", "s1").map((r) => ({ runId: r.runId, status: r.status }));
    assert.deepEqual(runs, [{ runId: "r-fresh", status: "open" }]);
    // Emitted entries land under the original turnId, including the result.
    const after = entryHead(sql, "s1").head;
    assert.ok(after > promptCursor);
    const entries = listEntries(sql, "s1", { after: promptCursor, limit: 50 });
    assert.ok(entries.length > 0);
    const result = entries.find((e) => e.type === "result");
    assert.ok(result !== undefined);
    assert.equal(bodyOf(result).runId, "t-orig");
    for (const e of entries) assert.equal(bodyOf(e).runId, "t-orig");
    // Chunk namespace continues under the turnId past the pinned prefix.
    const chunks = listChunksForTurn(sql, "s1", "t-orig");
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].seq, 0);
    for (const c of chunks) assert.equal(c.turnId, "t-orig");
    const seqs = chunks.map((c) => c.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  } finally {
    db.close();
  }
});
