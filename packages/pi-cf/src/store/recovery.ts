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
//   duplicated, and carries the resume record (ResumeTool per committed
//   toolCall, in order): completed pairs replay from the record and never
//   re-execute, in-flight calls re-execute once with only the result
//   emitted. A suffix-empty orphan whose prefix already holds a result or
//   error died between commit and row delete and just closes the row; a
//   suffix-empty orphan without one died mid-turn and still re-drives.
//   Success deletes the row; failure records one attempt.
// - retry: chunk seqs have gaps (or are empty), so no safe resume point
//   exists. Records one attempt, then the driver starts a fresh turn under
//   the same turnId (never re-open: the start cursor stays the resume
//   floor). A failed fresh drive keeps the already-recorded attempt.
//
// The scan never duplicates a committed entry: suffixForTurn emits only
// deltas after the last committed seq, resolved per chunk through the
// pi_chunks.cursor pin (cursor <= live head means the mirrored entry
// exists). Rows without a usable pin refuse instead of guessing.
// The resume record extends the same guarantee to tool execution:
// completed tools never run twice.
//
// Alarm wiring: RECOVERY_JOB fires through the mux like keepalive and
// compaction (earliest-deadline wins; scheduleJob never pushes a deadline
// later, so this scan cannot preempt compaction's max-age re-arm). The
// handler re-arms with summary.rearmAt, or rearmRecoveryScan for short.
import { entryHead, listEntries, type EntriesSql } from "./entries.ts";
import { listChunksForTurn, type ChunkRow } from "./chunks.ts";
import { commitPiRun, getPiRun, PI_RUN_MAX_ATTEMPTS, recordAttempt, type PiRunRow } from "./runs.ts";
import { parseJsonObject, strField } from "./sql-util.ts";

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

export interface ResumeTool {
  // One committed toolCall delta, in chunk-seq order. Survives the crash
  // because chunk and entry land in one transaction: a surviving toolCall
  // chunk always has its mirrored entry.
  id: string;
  tool: string;
  args: Record<string, unknown>;
  // Committed output for a completed toolCall/toolResult pair. Null when the
  // call committed but its result never landed (kill landed mid-tool): the
  // driver re-executes that tool once and emits only its result, so the
  // committed call entry is never duplicated. Non-null pairs are never
  // re-executed and never re-emitted.
  output: string | null;
}

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
  // Tool-aware resume record: committed toolCall deltas from the prefix at
  // or below the last committed seq, in order. Completed pairs (output
  // non-null) are replayed from the record, never re-executed; in-flight
  // calls (output null) are re-executed once with only the result emitted.
  // Empty on retry, where there is no safe resume point. Contract addition
  // for the tool-aware continuation lane: the driver ignores it on paths
  // that regenerate from the prompt.
  resume: ResumeTool[];
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

// Highest chunk seq whose mirrored entry is committed, resolved only
// through the pi_chunks.cursor pin: entry ids are never reused, so
// cursor <= live head means the entry exists (a fully-committed orphan
// left behind by a crash between commit and row delete resolves here,
// suffix empty). A turn with no usable pin (pre-migration NULL cursors,
// or a store predating the column) throws and the scan refuses it
// instead of guessing a suffix from entry counts.
export function lastCommittedSeq(
  sql: EntriesSql,
  sid: string,
  startCursor: number,
  turnId: string,
  chunks: readonly ChunkRow[],
): number {
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
    throw new Error("recovery refuses NULL-cursor turn: no cursor pin");
  }
  if (!pinned) throw new Error("recovery refuses NULL-cursor turn: no cursor pin");
  return last;
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

// Tool-aware resume record over the committed prefix (chunks at or below
// the last committed seq, in order). Pairs a toolCall delta with its
// toolResult by id: both halves committed means the tool already ran, so
// the pair survives with its output and must never re-execute. A call with
// no later result is in-flight (kill landed mid-tool): it survives with a
// null output so the driver re-executes it once and emits only the result.
// Non-tool deltas (prompt, text, result) carry no tool field and are
// ignored; an orphan result with no call is ignored. Unreadable bodies are
// skipped, never healed.
export function resumeToolsForPrefix(prefix: readonly ChunkRow[]): ResumeTool[] {
  const out: ResumeTool[] = [];
  const pending = new Map<string, number>();
  for (const chunk of prefix) {
    const obj = parseJsonObject(chunk.body);
    if (obj === null) continue;
    const id = strField(obj, "id");
    const tool = strField(obj, "tool");
    if (id === null || tool === null) continue;
    const rawArgs = obj["args"];
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) continue;
    const args = rawArgs as Record<string, unknown>;
    const output = strField(obj, "output");
    if (output !== null) {
      const slot = pending.get(id);
      if (slot !== undefined) {
        out[slot] = { id, tool, args: out[slot]?.args ?? args, output };
        pending.delete(id);
      }
      continue;
    }
    pending.set(id, out.length);
    out.push({ id, tool, args, output: null });
  }
  return out;
}

// True when the committed prefix already holds the turn's terminal delta:
// a result on success, an error on failure. A suffix-empty orphan past this
// point died between commit and row delete, so the scan just closes the row
// like before. A suffix-empty orphan WITHOUT one died before finishing
// (every delta committed, no terminal delta): it still needs a re-drive,
// which the resume record lets complete without re-executing anything.
export function prefixIsTerminal(prefix: readonly ChunkRow[]): boolean {
  for (const chunk of prefix) {
    const obj = parseJsonObject(chunk.body);
    if (obj === null) continue;
    if (strField(obj, "result") !== null || strField(obj, "error") !== null) return true;
  }
  return false;
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
      let suffix: ChunkRow[];
      try {
        suffix = suffixForTurn(sql, run.sid, run.cursor, run.turnId, chunks);
      } catch (e) {
        recordAttempt(sql, run.turnId, nowMs);
        summary.failed.push({ turnId: run.turnId, error: e instanceof Error ? e.message.slice(0, 300) : String(e ?? "re-drive failed").slice(0, 300) });
        continue;
      }
      const prefix = chunks.slice(0, chunks.length - suffix.length);
      if (suffix.length === 0 && prefixIsTerminal(prefix)) {
        // Fully committed: the crash landed between commit and row delete.
        // Nothing to re-drive; just close the row.
        commitPiRun(sql, run.turnId);
        summary.continued.push(run.turnId);
        continue;
      }
      // Suffix-empty without a terminal delta means the kill landed after
      // the last delta commit but before the turn finished: the resume
      // record below still completes it without re-executing anything.
      const resume = resumeToolsForPrefix(prefix);
      try {
        await driver.redrive({
          sid: run.sid,
          turnId: run.turnId,
          fence: run.fence,
          cursor: run.cursor,
          prompt,
          suffix,
          resume,
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
        resume: [],
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
