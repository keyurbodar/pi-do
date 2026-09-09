// recovery.ts — orphan-turn recovery scan.
//
// A pi_runs row opens when executeTurn takes a turn and is deleted when the
// turn commits (see runs.ts, stream.ts). A row that outlives its turn is an
// orphan: the process died between two durable writes (kill -9, DO eviction).
// scanTurns picks up orphans whose backoff has expired, classifies them from
// their pi_chunks rows, and re-drives them to completion through an injected
// driver (the DO wires the real model entrypoint at merge; this module never
// imports worker code).
//
// Per-turn state machine, per row:
// - due: nextRunAt <= now, else left alone for a later scan.
// - poison: attempts >= PI_RUN_MAX_ATTEMPTS means wedged; skipped, left
//   queryable, never retried.
// - live or freshly touched (updatedAt within two alarm periods): deferred.
//   updatedAt is refreshed on open and on every chunk flush, so a running
//   turn always looks fresh; only a dead turn goes stale.
// - continue: chunk seqs form 0..N contiguous. The driver replays only the
//   suffix after the last committed seq, so committed entries are never
//   duplicated. Success deletes the row; failure records one attempt.
// - retry: chunk seqs have gaps (or are empty), so no safe resume point
//   exists. Records one attempt, then the driver starts a fresh turn under
//   the same turnId (never re-open: the start cursor stays the resume
//   floor). A failed fresh drive keeps the already-recorded attempt.
//
// The scan never duplicates a committed entry: suffixForTurn emits only
// deltas after the last committed seq, resolved per chunk through the
// pi_chunks.cursor pin (cursor <= live head means the mirrored entry
// exists), with a count fallback for pre-migration rows whose cursor is
// NULL.
//
// Alarm wiring: RECOVERY_JOB fires through the mux like keepalive and
// compaction (earliest-deadline wins; scheduleJob never pushes a deadline
// later, so this scan cannot preempt compaction's max-age re-arm). The
// handler re-arms with summary.rearmAt, or rearmRecoveryScan for short.
import { entryHead, listEntries, type EntriesSql } from "./entries.ts";
import { listChunksForTurn, type ChunkRow } from "./chunks.ts";
import { commitPiRun, getPiRun, PI_RUN_MAX_ATTEMPTS, recordAttempt, type PiRunRow } from "./runs.ts";
import { parseJsonObject, readSingleRow, strField } from "./sql-util.ts";

// Alarm-mux job name for the recovery scan. Re-exported from the mux file
// so workspace-do.ts can register the handler without importing pi-cf twice.
export const RECOVERY_JOB = "recovery";

// One alarm period, matching the keepalive cadence. Orphan age is two of
// these (ORPHAN_AFTER_MS): a turn that died stops touching updatedAt, so
// after two missed periods it is unambiguously not live.
export const RECOVERY_SCAN_MS = 30_000;
export const ORPHAN_AFTER_MS = 2 * RECOVERY_SCAN_MS;

// Bounds model-driving work inside one alarm wakeup. Poison rows are cheap
// (skipped), but each continue/retry drives a full turn; the cap keeps one
// scan from monopolizing the DO. Rows past the cap are simply due on the
// next arming.
export const RECOVERY_MAX_PER_SCAN = 10;

export interface RedriveInput {
  sid: string;
  turnId: string;
  // Fence + start cursor as captured when the turn opened; the driver
  // re-validates the fence instead of rotating it.
  fence: string;
  cursor: number;
  // Prompt replayed from the first prompt entry after the start cursor;
  // null when it compacted away or was never committed.
  prompt: string | null;
  // Uncommitted deltas only (seqs after the last committed seq) on
  // continue; empty on retry, where the driver starts from the prompt.
  suffix: ChunkRow[];
  // Next free chunk seq for the turnId namespace (max seq + 1). Old chunk
  // rows are kept for the byte-math proof; post-wake deltas continue the
  // sequence so the (sid, turnId, seq) primary key never collides.
  nextSeq: number;
  // True when chunk seqs had gaps: no safe resume point, start over.
  fresh: boolean;
}

export interface RecoveryDriver {
  // True while the turn is still running in this process. The DO answers
  // from its live-turn map; the proof script answers false.
  isLive(sid: string, turnId: string): boolean;
  // Re-drives the turn to completion (appends post-wake deltas, commits
  // the result entry). Must NOT re-open the pi_runs row. Throws on
  // failure; scanTurns records the attempt.
  redrive(input: RedriveInput): Promise<void>;
}

export interface ScanFailure {
  turnId: string;
  error: string;
}

export interface ScanSummary {
  // Due rows examined this pass (capped at RECOVERY_MAX_PER_SCAN).
  scanned: number;
  // turnIds re-driven from their chunk suffix and committed (row deleted).
  continued: string[];
  // turnIds re-driven fresh and committed (row deleted).
  retried: string[];
  // turnIds left alone this pass: still live or touched too recently.
  deferred: string[];
  // turnIds at/over the poison threshold: skipped, left queryable.
  poison: string[];
  // turnIds whose re-drive threw (attempt recorded).
  failed: ScanFailure[];
  // now + RECOVERY_SCAN_MS: the handler's next scheduleJob deadline.
  rearmAt: number;
}

const PI_RUN_COLUMNS = "turnId, sid, fence, cursor, attempts, updatedAt, nextRunAt";

function toRunRow(row: unknown): PiRunRow | null {
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

// Every pi_runs row whose backoff has expired, oldest deadline first.
// Malformed rows are skipped, never healed.
export function duePiRuns(sql: EntriesSql, nowMs: number): PiRunRow[] {
  const out: PiRunRow[] = [];
  for (
    const row of sql.exec(
      `SELECT ${PI_RUN_COLUMNS} FROM pi_runs WHERE nextRunAt <= ? ORDER BY nextRunAt ASC`,
      nowMs,
    )
  ) {
    const parsed = toRunRow(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// Continue needs chunk rows forming seq 0..N contiguous. An empty turn has
// no resume point, so it retries fresh.
export function isContiguous(chunks: readonly ChunkRow[]): boolean {
  if (chunks.length === 0) return false;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].seq !== i) return false;
  }
  return true;
}

// Highest chunk seq whose mirrored entry is committed. Primary signal is
// the pi_chunks.cursor pin: entry ids are never reused, so cursor <= live
// head means the entry exists (a fully-committed orphan left behind by a
// crash between commit and row delete resolves here, suffix empty).
// Pre-migration rows have NULL cursors (written before the column
// existed); for an all-NULL turn, fall back to counting live entries past
// the turn's start cursor — the session queue is single-writer, so the
// first K entries after the start cursor pair with seqs 0..K-1.
export function lastCommittedSeq(
  sql: EntriesSql,
  sid: string,
  startCursor: number,
  turnId: string,
  chunks: readonly ChunkRow[],
): number {
  // One pass over the turn's pins: any usable cursor switches to pin
  // resolution, where the max committed seq wins. No usable cursor at all
  // (pre-migration NULL rows, or a store predating the column) falls through
  // to the entry-count fallback below.
  const head = entryHead(sql, sid).head;
  let last = -1;
  let pinned = false;
  try {
    for (
      const row of sql.exec("SELECT seq, cursor FROM pi_chunks WHERE sid = ? AND turnId = ? ORDER BY seq ASC", sid, turnId)
    ) {
      if (row === null || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq)) continue;
      if (typeof rec.cursor !== "number" || !Number.isInteger(rec.cursor)) continue;
      pinned = true;
      if (rec.cursor > 0 && rec.cursor <= head && rec.seq > last) last = rec.seq;
    }
  } catch {
    // Pre-migration store without the cursor column: count fallback below.
  }
  if (pinned) return last;
  const row = readSingleRow(sql, "SELECT COUNT(*) AS count FROM pi_entries WHERE sid = ? AND id > ?", sid, startCursor);
  const count = row !== null && typeof row.count === "number" && Number.isInteger(row.count) && row.count > 0 ? row.count : 0;
  return count - 1;
}

// Only deltas after the last committed seq. Emitting this suffix — never
// the full chunk log — is what keeps the woken turn byte-identical to an
// uninterrupted run instead of duplicating its prefix.
export function suffixForTurn(
  sql: EntriesSql,
  sid: string,
  startCursor: number,
  turnId: string,
  chunks: readonly ChunkRow[],
): ChunkRow[] {
  const last = lastCommittedSeq(sql, sid, startCursor, turnId, chunks);
  return chunks.filter((chunk) => chunk.seq > last);
}

// The turn's prompt: first prompt entry after the start cursor. Null when
// it never committed or compacted away; the driver then fails the re-drive
// instead of hallucinating a prompt.
export function readTurnPrompt(sql: EntriesSql, sid: string, startCursor: number): string | null {
  for (const entry of listEntries(sql, sid, { after: startCursor, limit: 32 })) {
    if (entry.type !== "prompt") continue;
    const obj = parseJsonObject(entry.body);
    if (obj === null) return null;
    return strField(obj, "prompt");
  }
  return null;
}

export async function scanTurns(sql: EntriesSql, nowMs: number, driver: RecoveryDriver): Promise<ScanSummary> {
  const summary: ScanSummary = {
    scanned: 0,
    continued: [],
    retried: [],
    deferred: [],
    poison: [],
    failed: [],
    rearmAt: nowMs + RECOVERY_SCAN_MS,
  };
  const due = duePiRuns(sql, nowMs).slice(0, RECOVERY_MAX_PER_SCAN);
  summary.scanned = due.length;
  for (const candidate of due) {
    // Re-read: the row may have committed (or been reaped) since listing.
    const run = getPiRun(sql, candidate.turnId);
    if (run === null) continue;
    if (run.attempts >= PI_RUN_MAX_ATTEMPTS) {
      summary.poison.push(run.turnId);
      continue;
    }
    if (driver.isLive(run.sid, run.turnId)) {
      summary.deferred.push(run.turnId);
      continue;
    }
    if (nowMs - run.updatedAt < ORPHAN_AFTER_MS) {
      summary.deferred.push(run.turnId);
      continue;
    }
    const chunks = listChunksForTurn(sql, run.sid, run.turnId);
    const prompt = readTurnPrompt(sql, run.sid, run.cursor);
    if (isContiguous(chunks)) {
      const suffix = suffixForTurn(sql, run.sid, run.cursor, run.turnId, chunks);
      if (suffix.length === 0) {
        // Fully committed: the crash landed between commit and row delete.
        // Nothing to re-drive; just close the row.
        commitPiRun(sql, run.turnId);
        summary.continued.push(run.turnId);
        continue;
      }
      try {
        await driver.redrive({
          sid: run.sid,
          turnId: run.turnId,
          fence: run.fence,
          cursor: run.cursor,
          prompt,
          suffix,
          nextSeq: chunks.length,
          fresh: false,
        });
        commitPiRun(sql, run.turnId);
        summary.continued.push(run.turnId);
      } catch (e) {
        recordAttempt(sql, run.turnId, nowMs);
        summary.failed.push({ turnId: run.turnId, error: e instanceof Error ? e.message.slice(0, 300) : String(e ?? "re-drive failed").slice(0, 300) });
      }
      continue;
    }
    // Gaps (or no chunks at all): no safe resume point. Count the fresh
    // turn as the attempt up front, so a turn that can never continue
    // still ages toward poison instead of hot-looping the alarm.
    if (recordAttempt(sql, run.turnId, nowMs) === null) continue;
    const nextSeq = chunks.length === 0 ? 0 : chunks[chunks.length - 1].seq + 1;
    try {
      await driver.redrive({
        sid: run.sid,
        turnId: run.turnId,
        fence: run.fence,
        cursor: run.cursor,
        prompt,
        suffix: [],
        nextSeq,
        fresh: true,
      });
      commitPiRun(sql, run.turnId);
      summary.retried.push(run.turnId);
    } catch (e) {
      summary.failed.push({ turnId: run.turnId, error: e instanceof Error ? e.message.slice(0, 300) : String(e ?? "re-drive failed").slice(0, 300) });
    }
  }
  return summary;
}

// Structural live-turn check for the DO wiring: pass the WorkspaceDO live
// map directly. A session with a starting turn (chunkTurn not yet armed)
// counts as live — conservative, so the scan never heals a turn that is
// mid-startup. A session running a *different* turnId leaves this row an
// orphan: its turn is gone.
export function makeSidLiveCheck(
  live: Map<string, { chunkTurn: { turnId: string } | null }>,
): (sid: string, turnId: string) => boolean {
  return (sid: string, turnId: string): boolean => {
    const entry = live.get(sid);
    if (entry === undefined) return false;
    if (entry.chunkTurn === null) return true;
    return entry.chunkTurn.turnId === turnId;
  };
}

// One-call re-arm for the alarm handler after a scan:
// scheduleJob(sql, RECOVERY_JOB, summary.rearmAt).
export function rearmRecoveryScan(schedule: (name: string, atMs: number) => void, nowMs: number): void {
  schedule(RECOVERY_JOB, nowMs + RECOVERY_SCAN_MS);
}
