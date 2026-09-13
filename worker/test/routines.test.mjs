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

function openDb(path) {
  const db = new DatabaseSync(path);
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

function makeSql(path = join(mkdtempSync(join(tmpdir(), "pi-do-routines-")), "test.db")) {
  const sql = openDb(path);
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
  assert.match(unknown.hint, /once/, "unknown kind hints the supported kinds");
});

test("interval parser enforces the 60s floor and rejects garbage", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const ok = routines.parseIntervalSpec("300", now);
  assert.equal(ok.ok, true);
  assert.equal(ok.atMs, now + 300_000);
  assert.equal(routines.parseIntervalSpec("60", now).ok, true);
  const low = routines.parseIntervalSpec("59", now);
  assert.equal(low.ok, false);
  assert.match(low.hint, />= 60/);
  assert.equal(routines.parseIntervalSpec("abc", now).ok, false);
  assert.equal(routines.parseIntervalSpec("3.5", now).ok, false);
});

test("weekly parser takes weekday:HH:MM and lands the next occurrence", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const ok = routines.parseWeeklySpec("mon:09:30", now);
  assert.equal(ok.ok, true);
  const got = new Date(ok.atMs);
  assert.equal(["sun", "mon", "tue", "wed", "thu", "fri", "sat"][got.getDay()], "mon");
  assert.equal(got.getHours(), 9);
  assert.equal(got.getMinutes(), 30);
  assert.ok(ok.atMs > now);
  const sameInstant = routines.parseWeeklySpec("mon:09:30", ok.atMs);
  assert.equal(sameInstant.atMs, ok.atMs + 7 * 86_400_000);
  const badTime = routines.parseWeeklySpec("mon:24:00", now);
  assert.equal(badTime.ok, false);
  assert.match(badTime.hint, /weekday:HH:MM/);
  assert.equal(routines.parseWeeklySpec("funday:09:30", now).ok, false);
  assert.equal(routines.parseWeeklySpec("mon:09:60", now).ok, false);
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

test("interval routine fires on due and recomputes next from now", async () => {
  const sql = makeSql();
  const now = Date.now();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "interval", spec: "60", prompt: "sweep" });
  assert.equal(created.ok, true);
  const id = created.routine.id;
  sql.exec("UPDATE pi_routines SET next_run_at = ? WHERE id = ?", now - 200_000, id);
  const fires = [];
  await routines.fireDueRoutines(sql, now, async (r) => fires.push(r.id));
  assert.deepEqual(fires, [id]);
  const row = routines.getRoutine(sql, "ws1", id);
  assert.equal(row.runCount, 1);
  assert.ok(Math.abs(row.nextRunAtMs - (now + 60_000)) < 50, "next run is one interval from now, not from the missed beat");
  assert.equal(scalar(sql, "SELECT min_interval_s FROM pi_routines WHERE id = ?", id), 60);
  await routines.fireDueRoutines(sql, now + 61_000, async (r) => fires.push(r.id));
  assert.equal(fires.length, 2);
  assert.equal(routines.getRoutine(sql, "ws1", id).runCount, 2);
});

test("interval downtime consumes exactly one overdue run", async () => {
  const sql = makeSql();
  const now = Date.now();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "interval", spec: "60", prompt: "sweep" });
  const id = created.routine.id;
  sql.exec("UPDATE pi_routines SET next_run_at = ? WHERE id = ?", now - 185_000, id);
  const fires = [];
  await routines.fireDueRoutines(sql, now, async (r) => fires.push(r.id));
  await routines.fireDueRoutines(sql, now, async (r) => fires.push(r.id));
  assert.equal(fires.length, 1);
  assert.equal(routines.getRoutine(sql, "ws1", id).runCount, 1);
});

test("weekly routine recomputes from now, never catching up", async () => {
  const sql = makeSql();
  const now = Date.now();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "weekly", spec: "mon:09:30", prompt: "digest" });
  assert.equal(created.ok, true);
  const id = created.routine.id;
  sql.exec("UPDATE pi_routines SET next_run_at = ? WHERE id = ?", now - 10 * 86_400_000, id);
  const fires = [];
  await routines.fireDueRoutines(sql, now, async (r) => fires.push(r.id));
  assert.equal(fires.length, 1);
  const row = routines.getRoutine(sql, "ws1", id);
  assert.equal(row.runCount, 1);
  const next = new Date(row.nextRunAtMs);
  assert.equal(["sun", "mon", "tue", "wed", "thu", "fri", "sat"][next.getDay()], "mon");
  assert.ok(row.nextRunAtMs > now);
});

test("expired routines deactivate before firing and keep their row", async () => {
  const sql = makeSql();
  const created = routines.createRoutine(sql, "ws1", "sid1", {
    kind: "once",
    spec: new Date(Date.now() + 60_000).toISOString(),
    prompt: "late news",
    expireAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(created.ok, true);
  const id = created.routine.id;
  const fires = [];
  await routines.fireDueRoutines(sql, Date.now() + 120_000, async (r) => fires.push(r.id));
  assert.deepEqual(fires, []);
  const row = routines.getRoutine(sql, "ws1", id);
  assert.equal(row.nextRunAtMs, null);
  assert.equal(row.runCount, 0);
  assert.equal(scalar(sql, "SELECT COUNT(*) FROM pi_routines WHERE ws = ?", "ws1"), 1);
});

test("create rejects malformed expireAt and maxRuns", () => {
  const sql = makeSql();
  const spec = new Date(Date.now() + 60_000).toISOString();
  const badExpire = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec, prompt: "p", expireAt: "soon" });
  assert.equal(badExpire.ok, false);
  assert.match(badExpire.hint, /ISO timestamp/);
  const badRuns = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec, prompt: "p", maxRuns: 0 });
  assert.equal(badRuns.ok, false);
  assert.match(badRuns.hint, />= 1/);
});

test("maxRuns deactivates after the last fire", async () => {
  const sql = makeSql();
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "interval", spec: "60", prompt: "twice", maxRuns: 2 });
  const id = created.routine.id;
  const now = Date.now();
  sql.exec("UPDATE pi_routines SET next_run_at = ? WHERE id = ?", now - 1000, id);
  const fires = [];
  await routines.fireDueRoutines(sql, now, async (r) => fires.push(r.id));
  sql.exec("UPDATE pi_routines SET next_run_at = ? WHERE id = ?", now + 1000, id);
  await routines.fireDueRoutines(sql, now + 2000, async (r) => fires.push(r.id));
  assert.equal(fires.length, 2);
  const row = routines.getRoutine(sql, "ws1", id);
  assert.equal(row.runCount, 2);
  assert.equal(row.nextRunAtMs, null);
});

test("the 51st active routine is rejected with a hint", () => {
  const sql = makeSql();
  const spec = new Date(Date.now() + 3_600_000).toISOString();
  for (let i = 0; i < routines.MAX_ACTIVE_ROUTINES; i++) {
    const r = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec, prompt: `p${i}` });
    assert.equal(r.ok, true);
  }
  const over = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec, prompt: "one too many" });
  assert.equal(over.ok, false);
  assert.match(over.error, /too many active routines/);
  assert.match(over.hint, /delete one/);
});

test("claim CAS holds across a reopen of the same store", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-do-routines-")), "restart.db");
  const sql = makeSql(path);
  const created = routines.createRoutine(sql, "ws1", "sid1", { kind: "once", spec: new Date(Date.now() - 1000).toISOString(), prompt: "p" });
  const id = created.routine.id;
  const seen = created.routine.claimEpoch;
  const reopened = makeSql(path);
  const fires = [];
  await routines.fireDueRoutines(reopened, Date.now(), async (r) => fires.push(r.id));
  assert.equal(fires.length, 1);
  const stale = routines.claimRoutine(sql, id, seen, Date.now());
  assert.equal(stale.claimed, false);
  assert.equal(routines.getRoutine(reopened, "ws1", id).runCount, 1);
});
