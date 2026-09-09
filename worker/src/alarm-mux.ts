// alarm-mux.ts — single-alarm multiplexer for WorkspaceDO.
//
// A Durable Object has one alarm slot, but several subsystems each want a
// wakeup: a running turn holds a keepalive heartbeat, compaction retries
// re-arm a short fuse, and the recovery scan sweeps orphaned pi_runs rows.
// The mux persists named jobs with deadlines in pi_alarm_jobs and always
// arms the single slot at the earliest deadline, so an earlier job (e.g. a
// compaction re-arm) preempts a later keepalive re-arm instead of being
// overwritten by it.
import type { EntriesSql } from "pi-cf/store/entries";
import { RECOVERY_JOB, RECOVERY_SCAN_MS } from "pi-cf/store/recovery";

export { RECOVERY_JOB, RECOVERY_SCAN_MS };

export const KEEPALIVE_JOB = "keepalive";
export const COMPACTION_JOB = "compaction";
export const KEEPALIVE_MS = 30_000;
export const COMPACTION_REARM_MS = 2_000;

export function ensureAlarmMuxSchema(sql: EntriesSql): void {
  sql.exec("CREATE TABLE IF NOT EXISTS pi_alarm_jobs(name TEXT PRIMARY KEY, atMs INTEGER NOT NULL)");
}

function rowAtMs(row: unknown): number | null {
  if (row === null || typeof row !== "object" || !("atMs" in row)) return null;
  const atMs: unknown = row.atMs;
  return typeof atMs === "number" && Number.isFinite(atMs) ? atMs : null;
}

// Insert or tighten a named job. Never pushes a deadline later: the mux
// keeps the earliest deadline per name, and returns the earliest deadline
// across all jobs (null when no jobs remain) so the caller can arm the
// single alarm slot at exactly that time.
export function scheduleJob(sql: EntriesSql, name: string, atMs: number): number | null {
  ensureAlarmMuxSchema(sql);
  sql.exec(
    "INSERT INTO pi_alarm_jobs(name, atMs) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET atMs = excluded.atMs WHERE excluded.atMs < pi_alarm_jobs.atMs",
    name,
    Math.trunc(atMs),
  );
  return earliestDeadline(sql);
}

export function earliestDeadline(sql: EntriesSql): number | null {
  for (const row of sql.exec("SELECT MIN(atMs) AS atMs FROM pi_alarm_jobs")) {
    return rowAtMs(row);
  }
  return null;
}

export function cancelJob(sql: EntriesSql, name: string): number | null {
  sql.exec("DELETE FROM pi_alarm_jobs WHERE name = ?", name);
  return earliestDeadline(sql);
}

export function dueJobs(sql: EntriesSql, nowMs: number): string[] {
  const out: string[] = [];
  for (const row of sql.exec("SELECT name FROM pi_alarm_jobs WHERE atMs <= ? ORDER BY atMs ASC", nowMs)) {
    if (row !== null && typeof row === "object" && "name" in row && typeof row.name === "string") {
      out.push(row.name);
    }
  }
  return out;
}

// Run every job due at nowMs. Each due row is consumed before its handler
// runs, so a handler that re-arms (compaction retry, live keepalive) lands a
// fresh row instead of spinning on the stale one; a handler that does not
// re-arm simply stays silent until the next scheduleJob. Unknown job names
// are consumed and skipped so a stale row can never wedge the alarm.
// Returns the names that had a handler, in firing order.
export async function runDueJobs(
  sql: EntriesSql,
  nowMs: number,
  handlers: Record<string, () => void | Promise<void>>,
): Promise<string[]> {
  const ran: string[] = [];
  for (const name of dueJobs(sql, nowMs)) {
    const handler = handlers[name];
    sql.exec("DELETE FROM pi_alarm_jobs WHERE name = ?", name);
    if (handler === undefined) continue;
    await handler();
    ran.push(name);
  }
  return ran;
}
