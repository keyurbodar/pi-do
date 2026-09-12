// overflow-recovery.test.mjs — proves the engine's single compact-and-retry
// on context overflow: an error tagged overflow:true (session.ts's
// isContextOverflow shape) at depth 0 forces exactly one runCompaction plus
// one retry; a non-overflow error never retries; a second overflow falls to
// the normal fail path. The turn body is the real executeTurnInner over
// DatabaseSync stores; only the session module is faked (a scripted
// createAgentSession whose run() throws per call), because the overflow shape
// can only originate from a keyed model turn.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const calls = { createAgentSession: 0 };
let script = [];

register("./ts-ext-hook.mjs", import.meta.url);
register("./overflow-recovery-session-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";

const { ensureWorkspaceSchema } = await import("pi-cf/store/sql-util");
const { ensureEntriesSchema, appendEntry, listEntries } = await import("pi-cf/store/entries");
const { ensureRunsSchema } = await import("pi-cf/store/runs");
const { ensureChunksSchema } = await import("pi-cf/store/chunks");
const { ensureEpisodeSchema } = await import("pi-cf/store/episode");
const compaction = await import("../src/compaction.ts");
const engine = await import("../src/stream-engine.ts");

globalThis.__overflowTest = { calls, get script() { return script; }, set script(v) { script = v; } };

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
      try { fn(); } catch (e) { db.exec("ROLLBACK"); throw e; }
      db.exec("COMMIT");
    },
  };
  ensureWorkspaceSchema(sql);
  ensureEntriesSchema(sql);
  ensureRunsSchema(sql);
  ensureChunksSchema(sql);
  ensureEpisodeSchema(sql);
  compaction.ensureCompactionSchema(sql);
  return sql;
}

function makeHost(sql) {
  return {
    sql, ws: "ws1", sid: "s1",
    files: {},
    shell: { exec: async () => ({ stdout: "", stderr: "", exit: 0, timedOut: false }) },
    runtimeEnv: {},
    thinking: null, retention: "short", model: null,
    workspaceKnown: true, sessionKnown: true,
    readFence: () => ({ fence: "f-live", revision: 7 }),
    casRotateFence: () => false,
    live: new Map(), sockets: () => [],
    enqueue: (fn) => fn(),
    scheduleAlarm: async () => {}, pokeAlarm: async () => {},
    holdKeepalive: async () => {}, releaseKeepalive: async () => {},
  };
}

function makeInput() {
  return { prompt: "hello", catalog: null, thinking: null, runId: "r1", turnId: "t1" };
}

function makeSink() {
  const sink = {
    pushed: [], doneIds: [], failed: [], abortedIds: [],
    push(type, body) { sink.pushed.push([type, body]); },
    done(runId, turn, runtime) { sink.doneIds.push(runId); },
    fail(runId, error, hint, status, opened) { sink.failed.push({ runId, error, hint, status }); },
    aborted(runId) { sink.abortedIds.push(runId); },
  };
  return sink;
}

function seedTurn(sql) {
  sql.exec("INSERT INTO sessions(sid, ws, created_at) VALUES (?, 'ws1', ?)", "s1", new Date().toISOString());
  // Enough turn history that the forced compaction has a prefix to archive
  // past COMPACTION_KEEP_TAIL.
  for (let i = 0; i < 20; i += 1) {
    appendEntry(sql, "s1", "prompt", { prompt: `turn ${i} prompt for the overflow test` });
    appendEntry(sql, "s1", "result", { runId: `r-${i}`, text: `done ${i}`, usage: { inTokens: 400, outTokens: 10, cacheRead: 0, costTotal: 0 } });
  }
}

const OVERFLOW_THROW = { error: "prompt is too long: 900000 tokens > 200000 maximum", hint: "ignored", overflow: true };
const PLAIN_THROW = { error: "model turn failed", hint: "retry the prompt" };

test("overflow at depth 0 runs exactly one compaction and one retry; second overflow fails normally", async () => {
  const { db, sql } = makeSqlAndDb();
  seedTurn(sql);
  const host = makeHost(sql);
  const sink = makeSink();
  script = [OVERFLOW_THROW, OVERFLOW_THROW];
  await engine.executeTurnInner(host, makeInput(), sink);
  assert.equal(calls.createAgentSession, 2, `expected one retry (two session constructions), got ${calls.createAgentSession}`);
  assert.equal(sink.failed.length, 1, "second overflow must land on the normal fail path");
  assert.equal(sink.failed[0].error, OVERFLOW_THROW.error);
  // The recovery compaction persisted: a compaction entry exists.
  const summaries = listEntries(sql, "s1", { after: 0 }).filter((e) => e.type === "compaction");
  assert.ok(summaries.length >= 1, "forced recovery compaction left no compactionSummary entry");
  assert.equal(sink.abortedIds.length, 0);
});

test("non-overflow errors fail without any retry or compaction", async () => {
  const { db, sql } = makeSqlAndDb();
  seedTurn(sql);
  const host = makeHost(sql);
  const sink = makeSink();
  script = [PLAIN_THROW];
  await engine.executeTurnInner(host, makeInput(), sink);
  assert.equal(calls.createAgentSession, 1, "non-overflow error must not retry");
  assert.equal(sink.failed.length, 1);
  assert.equal(sink.failed[0].hint, PLAIN_THROW.hint);
});

test("overflow recovered on the first retry succeeds", async () => {
  const { db, sql } = makeSqlAndDb();
  seedTurn(sql);
  const host = makeHost(sql);
  const sink = makeSink();
  script = [OVERFLOW_THROW, { ok: true }];
  await engine.executeTurnInner(host, makeInput(), sink);
  assert.equal(sink.doneIds.length, 1, "retry after recovery compaction must complete the turn");
  assert.equal(sink.failed.length, 0);
});

function makeSqlAndDb() {
  calls.createAgentSession = 0;
  const db = new DatabaseSync(":memory:");
  return { db, sql: makeSql(db) };
}
