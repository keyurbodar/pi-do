// stream-preempt.test.mjs — client turns preempt background redrive.
// A client open (WS prompt) aborts a live redrive-origin controller for the
// same sid first; client-origin entries are never aborted (racing clients
// still resolve via the fence, untouched). An aborted redrive reports
// redrive_aborted and still throws so the recovery scan records the attempt
// and backs off. Drives the real engine over DatabaseSync stores.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";

const { ensureEpisodeSchema } = await import("pi-cf/store/episode");
const { ensureWorkspaceSchema } = await import("pi-cf/store/sql-util");
const { ensureEntriesSchema } = await import("pi-cf/store/entries");
const { ensureRunsSchema } = await import("pi-cf/store/runs");
const engine = await import("../src/stream-engine.ts");
const { CLOSE_CONFLICT } = await import("../src/stream-codec.ts");

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
  return sql;
}

function openDb() {
  const db = new DatabaseSync(":memory:");
  return { db, sql: makeSql(db) };
}

// StreamHost double: inline session queue, live fence holder, stub runtime.
function makeHost(sql, sid = "s1") {
  return {
    sql,
    ws: "ws1",
    sid,
    files: {},
    shell: { exec: async () => ({ stdout: "", stderr: "", exit: 0, timedOut: false }) },
    runtimeEnv: {},
    thinking: null,
    retention: "short",
    model: null,
    workspaceKnown: true,
    sessionKnown: true,
    readFence: () => ({ fence: "f-live", revision: 7 }),
    casRotateFence: () => false,
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

// Stale revision against the live fence: the open path must still resolve
// through the fence 409 without ever reaching the model.
const STALE_FENCE_FRAME = JSON.stringify({ prompt: "hello", fence: "f-live", expected: 6 });

test("client open aborts a live redrive controller; fence 409 unchanged", async () => {
  const { db, sql } = openDb();
  try {
    const host = makeHost(sql);
    const seeded = new AbortController();
    host.live.set("s1", { controller: seeded, origin: "redrive", chunkTurn: null, chunkBuf: [] });
    const sock = collectSock();
    await engine.socketMessage(host, sock, STALE_FENCE_FRAME);
    assert.equal(seeded.signal.aborted, true);
    assert.equal(sock.sent.at(-1).error, "revision conflict");
    assert.deepEqual(sock.closed, [[CLOSE_CONFLICT, sock.closed[0][1]]]);
    assert.equal(sock.closed[0][0], 4409);
  } finally {
    db.close();
  }
});

test("client open never aborts a live client controller; fence 409 unchanged", async () => {
  const { db, sql } = openDb();
  try {
    const host = makeHost(sql);
    const seeded = new AbortController();
    host.live.set("s1", { controller: seeded, origin: "client", chunkTurn: null, chunkBuf: [] });
    const sock = collectSock();
    await engine.socketMessage(host, sock, STALE_FENCE_FRAME);
    assert.equal(seeded.signal.aborted, false);
    assert.equal(sock.sent.at(-1).error, "revision conflict");
    assert.equal(sock.closed[0][0], 4409);
  } finally {
    db.close();
  }
});

test("an aborted redrive reports redrive_aborted and still throws", async () => {
  const { db, sql } = openDb();
  try {
    const host = makeHost(sql);
    const reports = [];
    const input = { sid: "s1", turnId: "t1", fence: "", cursor: 0, suffix: [], resume: [], nextSeq: 0, fresh: true, prompt: "hi", skipDeltas: 0 };
    const pending = engine.redriveTurn(host, input, { report: (f) => reports.push(f) });
    // What a client open does on arrival: abort the redrive controller live.
    host.live.get("s1")?.controller.abort();
    await assert.rejects(pending, /re-drive aborted/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].error, "redrive_aborted");
    assert.equal(reports[0].turnId, "t1");
    assert.equal(host.live.get("s1"), undefined);
  } finally {
    db.close();
  }
});
