// runs.ts — durable per-turn ledger for crash recovery.
//
// A pi_runs row opens when executeTurn takes a turn (fence plus the last
// committed entry cursor captured) and is deleted when the turn commits. A
// row that outlives its turn is an orphan: the recovery scan (which only
// reads this table) picks it up once nextRunAt has passed, classifies
// continue vs retry from the turn's pi_chunks rows, and records each
// re-drive here via recordAttempt. Attempts >= 3 means wedged: the scan
// skips the row, leaving it queryable, and never retries it.
//
// Reaping: the compaction cutover transaction deletes rows whose start
// cursor fell into the archived prefix (cursor <= toCursor), except live
// turns the caller hands in, so the census stays flat across compactions.
import type { EntriesSql } from "./entries.ts";
import { readSingleRow } from "./sql-util.ts";

export const PI_RUNS_DDL =
  "CREATE TABLE IF NOT EXISTS pi_runs(turnId TEXT PRIMARY KEY, sid TEXT NOT NULL, fence TEXT NOT NULL, cursor INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, nextRunAt INTEGER NOT NULL DEFAULT 0)";

const PI_RUNS_SID_CURSOR_INDEX = "CREATE INDEX IF NOT EXISTS pi_runs_sid_cursor ON pi_runs(sid, cursor)";
const PI_RUNS_NEXT_RUN_INDEX = "CREATE INDEX IF NOT EXISTS pi_runs_next_run ON pi_runs(nextRunAt)";

export function ensureRunsSchema(sql: EntriesSql): void {
  sql.exec(PI_RUNS_DDL);
  sql.exec(PI_RUNS_SID_CURSOR_INDEX);
  sql.exec(PI_RUNS_NEXT_RUN_INDEX);
}

export interface PiRunRow {
  turnId: string;
  sid: string;
  fence: string;
  cursor: number;
  attempts: number;
  updatedAt: number;
  nextRunAt: number;
}

// Poison threshold: the recovery scan never retries a row at or past this.
export const PI_RUN_MAX_ATTEMPTS = 3;

// Backoff table: 2s, 4s, 8s, ... capped at 60s.
export const PI_RUN_BACKOFF_BASE_MS = 2000;
export const PI_RUN_BACKOFF_CAP_MS = 60000;

export function attemptBackoffMs(attempts: number): number {
  return Math.min(PI_RUN_BACKOFF_CAP_MS, PI_RUN_BACKOFF_BASE_MS * 2 ** attempts);
}

function toPiRunRow(row: unknown): PiRunRow | null {
  if (row === null || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  if (typeof rec.turnId !== "string" || typeof rec.sid !== "string" || typeof rec.fence !== "string") return null;
  if (
    typeof rec.cursor !== "number" || !Number.isInteger(rec.cursor) ||
    typeof rec.attempts !== "number" || !Number.isInteger(rec.attempts) ||
    typeof rec.updatedAt !== "number" || !Number.isInteger(rec.updatedAt) ||
    typeof rec.nextRunAt !== "number" || !Number.isInteger(rec.nextRunAt)
  ) {
    return null;
  }
  return {
    turnId: rec.turnId,
    sid: rec.sid,
    fence: rec.fence,
    cursor: rec.cursor,
    attempts: rec.attempts,
    updatedAt: rec.updatedAt,
    nextRunAt: rec.nextRunAt,
  };
}

const PI_RUN_COLUMNS = "turnId, sid, fence, cursor, attempts, updatedAt, nextRunAt";

// Opens the ledger row for a turn. The caller passes the head cursor as it
// stood when the turn started; re-drives must NOT re-open (the start cursor
// is the resume floor), they only record attempts. INSERT OR IGNORE keeps a
// redrive through executeTurn collision-free; a genuinely reused turnId still
// collides loudly at the first chunk append on (sid, turnId, seq).
export function openPiRun(sql: EntriesSql, sid: string, turnId: string, fence: string, cursor: number, nowMs: number = Date.now()): void {
  sql.exec(
    "INSERT OR IGNORE INTO pi_runs(turnId, sid, fence, cursor, attempts, updatedAt, nextRunAt) VALUES (?, ?, ?, ?, 0, ?, 0)",
    turnId,
    sid,
    fence,
    cursor,
    nowMs,
  );
}
// Earliest backoff deadline across rows, for alarm re-arming. Null when no
// rows remain and the scan needs no further wake.
export function nextRunAtMin(sql: EntriesSql): number | null {
  const row = readSingleRow(sql, "SELECT MIN(nextRunAt) AS m FROM pi_runs");
  const rec = row as { m?: unknown } | null;
  return rec !== null && typeof rec.m === "number" ? rec.m : null;
}

// Refreshes the liveness signal. Called on open and on every chunk flush,
// ideally inside the same transaction as the flush so updatedAt never runs
// ahead of durable data. Matches zero rows when the turn already committed.
export function touchPiRun(sql: EntriesSql, turnId: string, nowMs: number = Date.now()): void {
  sql.exec("UPDATE pi_runs SET updatedAt = ? WHERE turnId = ?", nowMs, turnId);
}

// Deletes the ledger row. Called only after the turn's commit landed; a row
// left behind by a crash between commit and delete reads as a
// fully-committed orphan whose suffix merge emits zero deltas.
export function commitPiRun(sql: EntriesSql, turnId: string): void {
  sql.exec("DELETE FROM pi_runs WHERE turnId = ?", turnId);
}

export function getPiRun(sql: EntriesSql, turnId: string): PiRunRow | null {
  return toPiRunRow(readSingleRow(sql, `SELECT ${PI_RUN_COLUMNS} FROM pi_runs WHERE turnId = ? LIMIT 1`, turnId));
}

export function listPiRunsForSession(sql: EntriesSql, sid: string): PiRunRow[] {
  const out: PiRunRow[] = [];
  for (const row of sql.exec(`SELECT ${PI_RUN_COLUMNS} FROM pi_runs WHERE sid = ? ORDER BY updatedAt ASC`, sid)) {
    const parsed = toPiRunRow(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// Records one re-drive: attempts increments and nextRunAt backs off from the
// post-increment count (attempt 1 -> +4s, 2 -> +8s, 3 -> +16s, capped at
// 60s). Unconditional: the scan decides wedgedness, this only records.
// Returns null when the row is gone (turn committed between scan and retry).
export function recordAttempt(sql: EntriesSql, turnId: string, nowMs: number = Date.now()): { attempts: number; nextRunAt: number } | null {
  const row = getPiRun(sql, turnId);
  if (row === null) return null;
  const attempts = row.attempts + 1;
  const nextRunAt = nowMs + attemptBackoffMs(attempts);
  sql.exec("UPDATE pi_runs SET attempts = ?, nextRunAt = ? WHERE turnId = ?", attempts, nextRunAt, turnId);
  return { attempts, nextRunAt };
}
