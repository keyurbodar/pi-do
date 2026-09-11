// episode.ts — durable episode state for crash consistency.
//
// The turn engine kept follow-up steer queues and the model-fallback flag
// in module-level Maps, so an isolate restart dropped queued steers and
// the fallback position mid-episode. Both now live in SQLite beside the
// entries/chunks/runs rows and are written before the frames they describe
// are emitted, so a fresh adapter over the same store sees the same
// episode. Created at boot beside the other schemas; no migration (new
// tables, CREATE IF NOT EXISTS).
import type { EntriesSql } from "./entries.ts";

export const STEER_QUEUE_DDL =
  "CREATE TABLE IF NOT EXISTS steer_queue(runId TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(runId, seq))";

export const MODEL_FALLBACK_DDL =
  "CREATE TABLE IF NOT EXISTS model_fallback(sid TEXT PRIMARY KEY, want TEXT NOT NULL, used TEXT NOT NULL)";

export function ensureEpisodeSchema(sql: EntriesSql): void {
  sql.exec(STEER_QUEUE_DDL);
  sql.exec(MODEL_FALLBACK_DDL);
}

export interface SteerRow {
  runId: string;
  seq: number;
  text: string;
  applied: boolean;
}

function toSteerRow(row: unknown, runId: string): SteerRow | null {
  if (row === null || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq)) return null;
  if (typeof rec.text !== "string" || typeof rec.applied !== "number") return null;
  return { runId, seq: rec.seq, text: rec.text, applied: rec.applied !== 0 };
}

// Enqueues one steer for the run in arrival order, returning its sequence.
// Callers persist the row before emitting the steer frame, so a crash
// between the two still leaves the steer queued for the next attach.
export function enqueueSteer(sql: EntriesSql, runId: string, text: string, applied = false): number {
  let next = 0;
  for (const row of sql.exec("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM steer_queue WHERE runId = ?", runId)) {
    if (row !== null && typeof row === "object" && "next" in row && typeof row.next === "number") next = row.next;
  }
  sql.exec("INSERT INTO steer_queue(runId, seq, text, applied) VALUES (?, ?, ?, ?)", runId, next, text, applied ? 1 : 0);
  return next;
}

export function listSteers(sql: EntriesSql, runId: string): SteerRow[] {
  const out: SteerRow[] = [];
  for (const row of sql.exec("SELECT seq, text, applied FROM steer_queue WHERE runId = ? ORDER BY seq", runId)) {
    const parsed = toSteerRow(row, runId);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function markSteerApplied(sql: EntriesSql, runId: string, seq: number): void {
  sql.exec("UPDATE steer_queue SET applied = 1 WHERE runId = ? AND seq = ?", runId, seq);
}

// The turn's finally clears its rows; like the Map delete before it, a
// turn that ends with still-pending steers reports them in its ack and
// drops them, never leaks them into the next turn.
export function clearSteers(sql: EntriesSql, runId: string): void {
  sql.exec("DELETE FROM steer_queue WHERE runId = ?", runId);
}

// Reconciliation shape the done/abort/fail acks send: applied count plus
// the still-pending texts, so no steer goes silent.
export function steerOutcome(sql: EntriesSql, runId: string): { applied: number; pending: string[] } {
  const queue = listSteers(sql, runId);
  return { applied: queue.filter((s) => s.applied).length, pending: queue.filter((s) => !s.applied).map((s) => s.text) };
}

export interface ModelFallbackRow {
  want: string;
  used: string;
}

export function getFallback(sql: EntriesSql, sid: string): ModelFallbackRow | null {
  for (const row of sql.exec("SELECT want, used FROM model_fallback WHERE sid = ? LIMIT 1", sid)) {
    if (row !== null && typeof row === "object") {
      const rec = row as Record<string, unknown>;
      if (typeof rec.want === "string" && typeof rec.used === "string") return { want: rec.want, used: rec.used };
    }
  }
  return null;
}

// A cycled turn records what it fell back from and to; the next turn that
// resolves the preferred entry clears the row and reports the restore.
export function setFallback(sql: EntriesSql, sid: string, want: string, used: string): void {
  sql.exec("INSERT OR REPLACE INTO model_fallback(sid, want, used) VALUES (?, ?, ?)", sid, want, used);
}

export function clearFallback(sql: EntriesSql, sid: string): void {
  sql.exec("DELETE FROM model_fallback WHERE sid = ?", sid);
}
