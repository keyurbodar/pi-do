// store.test.mjs — fast conformance suite for the pi-cf store: crashed-vs-clean
// runs, cursor pins, checkpoints, entry validation, usage buckets. Every test
// drives a real DatabaseSync :memory: store; no mocks, no servers.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  appendEntry,
  ensureEntriesSchema,
  entryHead,
  listEntries,
  openRun,
  recordTurnWithOpen,
  sumResultUsage,
  sumUsageByModel,
} from "../src/store/entries.ts";
import { ensureWorkspaceSchema } from "../src/store/sql-util.ts";
import {
  createCheckpoint,
  ensureCheckpointsSchema,
  getCheckpoint,
  listCheckpoints,
  rewindSession,
} from "../src/store/checkpoints.ts";
import { appendChunk, ensureChunksSchema, listChunksForTurn } from "../src/store/chunks.ts";
import { lastCommittedSeq } from "../src/store/recovery.ts";

function makeSql(sids = []) {
  const db = new DatabaseSync(":memory:");
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
    statusOf(runId) {
      for (const row of sql.exec("SELECT status FROM runs WHERE runId = ? LIMIT 1", runId)) return row.status;
      return undefined;
    },
    leafOf(sid) {
      for (const row of sql.exec("SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid)) return row.leaf ?? 0;
      return 0;
    },
  };
  ensureWorkspaceSchema(sql);
  ensureEntriesSchema(sql);
  for (const sid of sids) sql.exec("INSERT OR IGNORE INTO sessions(sid) VALUES (?)", sid);
  return sql;
}

function throwsNamed(fn, name) {
  try {
    fn();
  } catch (e) {
    assert.equal(e?.error, name);
    return;
  }
  assert.fail(`expected throw { error: ${name} }`);
}

// Port of the verify-runs.mjs crashed-vs-clean proof: a committed turn closes
// clean, and only an unclosed run is marked interrupted when the next one opens.
test("crashed runs interrupt on next open while clean runs stay clean", () => {
  const sql = makeSql(["s1"]);
  recordTurnWithOpen(sql, "s1", "r1", "read seed.txt",
    [{ id: "t1", tool: "read", args: { path: "seed.txt" }, output: "seeded" }], "done");
  assert.equal(sql.statusOf("r1"), "closed");
  openRun(sql, "s1", "r2");
  assert.equal(sql.statusOf("r2"), "open");
  assert.deepEqual(listEntries(sql, "s1").filter((e) => e.type === "interrupted"), []);
  assert.deepEqual(listEntries(sql, "s1").map((e) => e.type), ["prompt", "toolCall", "toolResult", "result"]);
  assert.deepEqual(listEntries(sql, "s1").map((e) => JSON.parse(e.body).runId), ["r1", "r1", "r1", "r1"]);
  openRun(sql, "s1", "r3");
  assert.equal(sql.statusOf("r2"), "interrupted");
  assert.equal(sql.statusOf("r3"), "open");
  const interrupted = listEntries(sql, "s1").filter((e) => e.type === "interrupted");
  assert.equal(interrupted.length, 1);
  assert.deepEqual(JSON.parse(interrupted[0].body), { runId: "r2", interruptedBy: "r3" });
});

test("recovery refuses NULL-cursor turns but resolves pinned ones", () => {
  const sql = makeSql(["s1"]);
  ensureChunksSchema(sql);
  appendChunk(sql, "s1", "t-null", 0, "delta-0");
  appendChunk(sql, "s1", "t-null", 1, "delta-1");
  const unpinned = listChunksForTurn(sql, "s1", "t-null");
  assert.ok(unpinned.every((c) => c.cursor === null));
  assert.throws(() => lastCommittedSeq(sql, "s1", 0, "t-null", unpinned), /no cursor pin/);
  const cursor = appendEntry(sql, "s1", "text", { runId: "t-pin", delta: "hi" });
  appendChunk(sql, "s1", "t-pin", 0, "delta-0", cursor);
  assert.equal(lastCommittedSeq(sql, "s1", 0, "t-pin", listChunksForTurn(sql, "s1", "t-pin")), 0);
});

test("checkpoint create/rewind round-trips the branch summary and spares siblings", () => {
  const sql = makeSql(["s1", "s2"]);
  ensureCheckpointsSchema(sql);
  recordTurnWithOpen(sql, "s1", "r1", "first", [], "one");
  const cp = createCheckpoint(sql, "s1", "cp1", 1, "before");
  assert.deepEqual(getCheckpoint(sql, "s1", "cp1"), cp);
  assert.equal(listCheckpoints(sql, "s1").length, 1);
  recordTurnWithOpen(sql, "s2", "s2r1", "sibling", [], "sib");
  const s2leaf = sql.leafOf("s2");
  const s2count = entryHead(sql, "s2").count;
  recordTurnWithOpen(sql, "s1", "r2", "second", [], "two");
  const tailBefore = listEntries(sql, "s1").length - 1;
  const res = rewindSession(sql, "s1", 1);
  assert.equal(res.cursor, 1);
  assert.equal(res.abandoned.count, tailBefore);
  assert.equal(res.leaf, res.summaryCursor);
  assert.equal(sql.leafOf("s1"), res.summaryCursor);
  const rows = listEntries(sql, "s1");
  assert.equal(rows.at(-1).type, "branch-summary");
  const summary = JSON.parse(rows.at(-1).body);
  assert.equal(summary.cursor, 1);
  assert.deepEqual(summary.lineage, ["s1"]);
  assert.equal(summary.abandoned.count, tailBefore);
  assert.equal(sql.leafOf("s2"), s2leaf);
  assert.equal(entryHead(sql, "s2").count, s2count);
});

test("validation rejects non-serializable bodies before any insert", () => {
  const sql = makeSql(["s1"]);
  const before = entryHead(sql, "s1").count;
  throwsNamed(() => appendEntry(sql, "s1", "prompt", undefined), "entry_body_not_serializable");
  assert.equal(entryHead(sql, "s1").count, before);
});

test("validation rejects duplicate (type, runId, id) commits but keeps cross-type halves", () => {
  const sql = makeSql(["s1"]);
  appendEntry(sql, "s1", "toolCall", { runId: "r1", id: "dup", tool: "read", args: {} });
  throwsNamed(
    () => appendEntry(sql, "s1", "toolCall", { runId: "r1", id: "dup", tool: "read", args: {} }),
    "entry_duplicate_id",
  );
  appendEntry(sql, "s1", "toolResult", { runId: "r1", id: "dup", tool: "read", output: "ok" });
  assert.equal(listEntries(sql, "s1").length, 2);
});

test("validation rejects appends when the session leaf points outside the chain", () => {
  const sql = makeSql(["s1"]);
  recordTurnWithOpen(sql, "s1", "r1", "hi", [], "done");
  const before = entryHead(sql, "s1").count;
  sql.exec("UPDATE sessions SET leaf = ? WHERE sid = ?", 9999, "s1");
  throwsNamed(() => appendEntry(sql, "s1", "prompt", { runId: "r2", prompt: "x" }), "entry_chain_broken");
  assert.equal(entryHead(sql, "s1").count, before);
});

test("usage buckets sum back to session totals", () => {
  const sql = makeSql(["s1"]);
  recordTurnWithOpen(sql, "s1", "r1", "a", [], "one",
    { inTokens: 10, outTokens: 20, cacheRead: 5, costTotal: 0.5, elapsedMs: 100, tokensPerSec: null });
  recordTurnWithOpen(sql, "s1", "r2", "b", [], "two",
    { inTokens: 1, outTokens: 2, cacheRead: 3, costTotal: 0.25, elapsedMs: 50, tokensPerSec: null },
    { reason: "cost" });
  const totals = sumResultUsage(sql, "s1");
  const buckets = sumUsageByModel(sql, "s1");
  assert.deepEqual(buckets.map((b) => b.cause).sort(), ["cost", "stop"]);
  for (const key of ["inTokens", "outTokens", "cacheRead", "costTotal", "elapsedMs"]) {
    assert.equal(buckets.reduce((n, b) => n + b[key], 0), totals[key]);
  }
});

// Backfill hygiene: ensure probes before writing so a clean database sees
// zero writes (no SQLITE_BUSY window) while legacy rows still get fixed.
// Each ensure uses a fresh adapter object to defeat the per-object once-gate,
// the way per-request adapters do in production.
function wrapDb(db) {
  return {
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
}

function changeCount(db) {
  return db.prepare("SELECT total_changes() AS n").get().n;
}

test("ensure performs zero writes on a clean database", () => {
  const db = new DatabaseSync(":memory:");
  const sql = wrapDb(db);
  ensureWorkspaceSchema(sql);
  ensureEntriesSchema(sql);
  sql.exec("INSERT OR IGNORE INTO sessions(sid) VALUES (?)", "s1");
  recordTurnWithOpen(sql, "s1", "r1", "hi", [], "done",
    { inTokens: 10, outTokens: 20, cacheRead: 5, costTotal: 0.5, elapsedMs: 100, tokensPerSec: null });
  const before = changeCount(db);
  ensureEntriesSchema(wrapDb(db));
  assert.equal(changeCount(db), before);
});

test("ensure backfills legacy leaf-zero sessions with entries", () => {
  const db = new DatabaseSync(":memory:");
  const sql = wrapDb(db);
  ensureWorkspaceSchema(sql);
  ensureEntriesSchema(sql);
  sql.exec("INSERT OR IGNORE INTO sessions(sid) VALUES (?)", "legacy");
  db.prepare("INSERT INTO pi_entries(sid, parent, type, body) VALUES (?, ?, ?, ?)")
    .run("legacy", 0, "prompt", JSON.stringify({ runId: "r0", prompt: "old" }));
  db.prepare("INSERT INTO pi_entries(sid, parent, type, body) VALUES (?, ?, ?, ?)")
    .run("legacy", 1, "prompt", JSON.stringify({ runId: "r0", prompt: "older" }));
  const head = db.prepare("SELECT MAX(id) AS m FROM pi_entries WHERE sid = ?").get("legacy").m;
  ensureEntriesSchema(wrapDb(db));
  assert.equal(db.prepare("SELECT leaf FROM sessions WHERE sid = ?").get("legacy").leaf, head);
  const before = changeCount(db);
  ensureEntriesSchema(wrapDb(db));
  assert.equal(changeCount(db), before);
});

test("ensure seeds totals for sids missing them without touching existing rows", () => {
  const db = new DatabaseSync(":memory:");
  const sql = wrapDb(db);
  ensureWorkspaceSchema(sql);
  ensureEntriesSchema(sql);
  sql.exec("INSERT OR IGNORE INTO sessions(sid) VALUES (?)", "sA");
  sql.exec("INSERT OR IGNORE INTO sessions(sid) VALUES (?)", "sB");
  recordTurnWithOpen(sql, "sA", "rA", "a", [], "one",
    { inTokens: 10, outTokens: 20, cacheRead: 5, costTotal: 0.5, elapsedMs: 100, tokensPerSec: null });
  const body = JSON.stringify({ runId: "rB", result: "old", usage: { inTokens: 3, outTokens: 4, cacheRead: 1, costTotal: 0.1, elapsedMs: 30 } });
  db.prepare("INSERT INTO pi_entries(sid, parent, type, body) VALUES (?, ?, ?, ?)")
    .run("sB", 0, "result", body);
  const kept = db.prepare("SELECT * FROM session_totals WHERE sid = ?").get("sA");
  ensureEntriesSchema(wrapDb(db));
  const seeded = db.prepare("SELECT * FROM session_totals WHERE sid = ?").get("sB");
  assert.equal(seeded.turns, 1);
  assert.equal(seeded.inTokens, 3);
  assert.equal(seeded.outTokens, 4);
  assert.deepEqual(db.prepare("SELECT * FROM session_totals WHERE sid = ?").get("sA"), kept);
});
