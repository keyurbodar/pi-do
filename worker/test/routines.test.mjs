// routines.test.mjs — routine schedule parsing, claim CAS exactly-once, and
// the once-schedule fire path, driven over the real SQL store (no mocks).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const routines = await import("../src/routines.ts");
const { ensureEntriesSchema } = await import("pi-cf/store/entries");
const { ensureWorkspaceSchema } = await import("pi-cf/store/sql-util");

function makeSql() {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "pi-do-routines-")), "test.db"));
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
  return sql;
}

function scalar(sql, query, ...bindings) {
  for (const row of sql.exec(query, ...bindings)) return Object.values(row)[0];
  return undefined;
}

test("once parser accepts ISO and rejects garbage with a hint", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const ok = routines.parseOnceSpec("2026-01-02T03:04:05.000Z", now);
  assert.equal(ok.ok, true);
  assert.equal(ok.atMs, Date.parse("2026-01-02T03:04:05.000Z"));
  const bad = routines.parseOnceSpec("not a time", now);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /bad once schedule/);
  assert.match(bad.hint, /ISO timestamp/);
  const unknown = routines.firstRunAt("hourly", "5", now);
  assert.equal(unknown.ok, false);
  assert.match(unknown.hint, /interval and weekly/);
});

test("create validates kind, spec, and prompt with {error, hint}", () => {
  const sql = makeSql();
  assert.match(routines.createRoutine(sql, "w", "s", { kind: "once", spec: "nope", prompt: "hi" }).hint, /ISO timestamp/);
  assert.match(routines.createRoutine(sql, "w", "s", { kind: "once", spec: "2026-01-02T00:00:00Z", prompt: "" }).error, /missing prompt/);
  assert.match(routines.createRoutine(sql, "w", "s", { kind: "bogus", spec: "2026-01-02T00:00:00Z", prompt: "hi" }).error, /unsupported schedule kind/);
});

test("once routine fires exactly once through the alarm path", async () => {
  const sql = makeSql();
  const now = Date.now();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec: new Date(now - 1000).toISOString(), prompt: "check the inbox" });
  assert.equal(created.ok, true);
  const id = created.routine.id;
  const jobAt = scalar(sql, "SELECT atMs FROM pi_alarm_jobs WHERE name = ?", routines.ROUTINE_JOB);
  assert.equal(jobAt, Date.parse(new Date(now - 1000).toISOString()));

  const fires = [];
  const fired = await routines.fireDueRoutines(sql, now + 10_000, async (r) => fires.push(r.id));
  assert.deepEqual(fired, [id]);
  assert.deepEqual(fires, [id]);
  const row = routines.getRoutine(sql, "ws1", id);
  assert.equal(row.nextRunAtMs, null);
  assert.equal(row.runCount, 1);
  assert.equal(row.claimEpoch, 1);
  assert.equal(scalar(sql, "SELECT COUNT(*) FROM pi_alarm_jobs WHERE name = ?", routines.ROUTINE_JOB), 0);

  const again = await routines.fireDueRoutines(sql, now + 20_000, async (r) => fires.push(r.id));
  assert.deepEqual(again, []);
  assert.equal(fires.length, 1);
  assert.equal(routines.getRoutine(sql, "ws1", id).runCount, 1);
});

test("claim CAS: two claims against one due row fire once", () => {
  const sql = makeSql();
  const now = Date.now();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec: new Date(now - 500).toISOString(), prompt: "p" });
  const id = created.routine.id;
  const seen = created.routine.claimEpoch;
  const first = routines.claimRoutine(sql, id, seen, now + 1000);
  assert.equal(first.claimed, true);
  const second = routines.claimRoutine(sql, id, seen, now + 1000);
  assert.equal(second.claimed, false);
  const row = routines.getRoutine(sql, "ws1", id);
  assert.equal(row.runCount, 1);
  assert.equal(row.claimEpoch, seen + 1);
});

test("stale epoch never claims even when the row looks due", () => {
  const sql = makeSql();
  const now = Date.now();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec: new Date(now + 60_000).toISOString(), prompt: "p" });
  const id = created.routine.id;
  const future = routines.claimRoutine(sql, id, created.routine.claimEpoch, now);
  assert.equal(future.claimed, false);
  assert.equal(routines.getRoutine(sql, "ws1", id).runCount, 0);
});

test("requestId dedupes creates to one routine", () => {
  const sql = makeSql();
  const spec = new Date(Date.now() + 60_000).toISOString();
  const a = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec, prompt: "p", requestId: "req-1" });
  const b = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec, prompt: "p", requestId: "req-1" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.routine.id, a.routine.id);
  assert.equal(scalar(sql, "SELECT COUNT(*) FROM pi_routines WHERE ws = ?", "ws1"), 1);
});

test("delete removes the row and drops the alarm job when none remain", () => {
  const sql = makeSql();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec: new Date(Date.now() + 60_000).toISOString(), prompt: "p" });
  assert.equal(routines.deleteRoutine(sql, "ws1", created.routine.id), true);
  assert.equal(routines.getRoutine(sql, "ws1", created.routine.id), null);
  assert.equal(scalar(sql, "SELECT COUNT(*) FROM pi_alarm_jobs WHERE name = ?", routines.ROUTINE_JOB), 0);
  assert.equal(routines.deleteRoutine(sql, "ws1", created.routine.id), false);
});

test("rearm points the mux at the earliest routine and survives later creates", () => {
  const sql = makeSql();
  const early = new Date(Date.now() + 30_000).toISOString();
  const late = new Date(Date.now() + 120_000).toISOString();
  routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec: late, prompt: "late" });
  assert.equal(scalar(sql, "SELECT atMs FROM pi_alarm_jobs WHERE name = ?", routines.ROUTINE_JOB), Date.parse(late));
  routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec: early, prompt: "early" });
  assert.equal(scalar(sql, "SELECT atMs FROM pi_alarm_jobs WHERE name = ?", routines.ROUTINE_JOB), Date.parse(early));
});
