// routines.ts — scheduled durable turns.
//
// Read-only pattern refs (never imported):
// - /tmp/grok-research/akeru-bot packages/contracts/src/routines.ts and
//   apps/server/src/routines/: schedule parse shape, claim-based
//   single-owner runs.
// - /tmp/grok-research/noodle Sources/NoodleCore/AgentHeartbeat.swift:
//   persisted last-fire wins, consume exactly one overdue beat, next beat
//   computed from now (no catch-up bursts).
//
// A firing routine is a prompt entering the existing turn pipeline: the
// alarm claims the row with a SQL compare-and-set (claim_epoch guard, one
// winner), enqueues the prompt through the session's normal queue, and
// recomputes next_run_at from now. A NULL next_run_at is the deactivated
// state (once fired, expired, or max_runs reached); the row stays for audit.
import { ensureTables, CREATE_TABLES, readScalar, readSingleRow } from "pi-cf/store/sql-util";
import type { EntriesSql } from "pi-cf/store/entries";
import { cancelJob, ensureAlarmMuxSchema, scheduleJob } from "./alarm-mux";

export const ROUTINE_JOB = "routines";
export const MIN_INTERVAL_S = 60;
export const MAX_ACTIVE_ROUTINES = 50;

export function ensureRoutinesSchema(sql: EntriesSql): void {
  ensureTables(sql, [CREATE_TABLES.piRoutines]);
}

export type ScheduleFailure = { ok: false; error: string; hint: string };
export type ParsedSchedule = { ok: true; atMs: number } | ScheduleFailure;

export function parseOnceSpec(spec: string, fromMs: number): ParsedSchedule {
  const t = Date.parse(spec);
  if (!Number.isFinite(t)) {
    return { ok: false, error: "bad once schedule", hint: `schedule_spec must be an ISO timestamp, e.g. ${new Date(fromMs + 60_000).toISOString()}` };
  }
  return { ok: true, atMs: t };
}

export function parseIntervalSpec(spec: string, fromMs: number): ParsedSchedule {
  const s = Number(spec);
  if (!Number.isInteger(s) || s < MIN_INTERVAL_S) {
    return { ok: false, error: "bad interval schedule", hint: `schedule_spec must be a whole number of seconds >= ${MIN_INTERVAL_S}, e.g. "300"` };
  }
  return { ok: true, atMs: fromMs + s * 1000 };
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKLY_RE = /^([a-z]{3}):([01]\d|2[0-3]):([0-5]\d)$/;

export function parseWeeklySpec(spec: string, fromMs: number): ParsedSchedule {
  const m = WEEKLY_RE.exec(spec);
  if (m === null || WEEKDAYS.indexOf(m[1]) < 0) {
    return { ok: false, error: "bad weekly schedule", hint: 'schedule_spec must be weekday:HH:MM, e.g. "mon:09:30"' };
  }
  const d = new Date(fromMs);
  d.setHours(Number(m[2]), Number(m[3]), 0, 0);
  const daysAhead = (WEEKDAYS.indexOf(m[1]) - d.getDay() + 7) % 7;
  const candidate = d.getTime() + daysAhead * 86_400_000;
  return { ok: true, atMs: candidate <= fromMs ? candidate + 7 * 86_400_000 : candidate };
}

export function firstRunAt(kind: string, spec: string, nowMs: number): ParsedSchedule {
  if (kind === "once") return parseOnceSpec(spec, nowMs);
  if (kind === "interval") return parseIntervalSpec(spec, nowMs);
  if (kind === "weekly") return parseWeeklySpec(spec, nowMs);
  return { ok: false, error: `unsupported schedule kind: ${kind}`, hint: 'schedule_kind is "once", "interval", or "weekly"' };
}

// Next fire after nowMs, or null when the schedule consumes itself (once) or
// its spec no longer parses (deactivate rather than fire on garbage). Missed
// beats are never caught up: the caller recomputes from now.
export function nextRunAfter(kind: string, spec: string, nowMs: number): number | null {
  if (kind === "once") return null;
  const parsed = firstRunAt(kind, spec, nowMs);
  return parsed.ok ? parsed.atMs : null;
}

export interface RoutineRow {
  id: string;
  ws: string;
  sid: string;
  scheduleKind: string;
  scheduleSpec: string;
  prompt: string;
  nextRunAtMs: number | null;
  expireAtMs: number | null;
  maxRuns: number | null;
  runCount: number;
  claimEpoch: number;
}

const SELECT_ROUTINE =
  "SELECT id, ws, sid, schedule_kind AS scheduleKind, schedule_spec AS scheduleSpec, prompt, next_run_at AS nextRunAtMs, expire_at AS expireAtMs, max_runs AS maxRuns, run_count AS runCount, claim_epoch AS claimEpoch FROM pi_routines";

function toRoutineRow(row: unknown): RoutineRow | null {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.ws !== "string" || typeof r.sid !== "string") return null;
  if (typeof r.scheduleKind !== "string" || typeof r.scheduleSpec !== "string" || typeof r.prompt !== "string") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: r.id,
    ws: r.ws,
    sid: r.sid,
    scheduleKind: r.scheduleKind,
    scheduleSpec: r.scheduleSpec,
    prompt: r.prompt,
    nextRunAtMs: num(r.nextRunAtMs),
    expireAtMs: num(r.expireAtMs),
    maxRuns: num(r.maxRuns),
    runCount: typeof r.runCount === "number" ? r.runCount : 0,
    claimEpoch: typeof r.claimEpoch === "number" ? r.claimEpoch : 0,
  };
}

export function getRoutine(sql: EntriesSql, ws: string, id: string): RoutineRow | null {
  return toRoutineRow(readSingleRow(sql, `${SELECT_ROUTINE} WHERE ws = ? AND id = ? LIMIT 1`, ws, id));
}

export function listRoutines(sql: EntriesSql, ws: string): RoutineRow[] {
  const out: RoutineRow[] = [];
  for (const row of sql.exec(`${SELECT_ROUTINE} WHERE ws = ? ORDER BY (next_run_at IS NULL), next_run_at`, ws)) {
    const parsed = toRoutineRow(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// Point the mux's single alarm slot at the earliest routine fire. The job row
// is deleted first because scheduleJob only tightens deadlines and a delete
// can move the earliest fire later.
export function rearmRoutines(sql: EntriesSql): number | null {
  ensureRoutinesSchema(sql);
  ensureAlarmMuxSchema(sql);
  cancelJob(sql, ROUTINE_JOB);
  const min = readScalar<number>(sql, "SELECT MIN(next_run_at) AS atMs FROM pi_routines WHERE next_run_at IS NOT NULL");
  if (typeof min !== "number" || !Number.isFinite(min)) return null;
  return scheduleJob(sql, ROUTINE_JOB, min);
}

export interface CreateRoutineInput {
  kind: unknown;
  spec: unknown;
  prompt: unknown;
  expireAt?: unknown;
  maxRuns?: unknown;
  createdBy?: string;
  requestId?: string | null;
}

export type CreateRoutineResult = { ok: true; routine: RoutineRow } | ScheduleFailure;

export function createRoutine(sql: EntriesSql, ws: string, sid: string, input: CreateRoutineInput): CreateRoutineResult {
  ensureRoutinesSchema(sql);
  if (typeof input.requestId === "string" && input.requestId.length > 0) {
    const existing = getRoutineByRequest(sql, ws, input.requestId);
    if (existing !== null) return { ok: true, routine: existing };
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    return { ok: false, error: "missing prompt", hint: 'retry with {"prompt": "check the inbox and summarize"}' };
  }
  if (typeof input.kind !== "string" || typeof input.spec !== "string" || input.spec.length === 0) {
    return { ok: false, error: "bad schedule", hint: 'retry with {"kind": "once", "spec": "<ISO timestamp>"}' };
  }
  const now = Date.now();
  const first = firstRunAt(input.kind, input.spec, now);
  if (!first.ok) return first;
  let expireAtMs: number | null = null;
  if (input.expireAt !== undefined) {
    if (typeof input.expireAt !== "string" || !Number.isFinite(Date.parse(input.expireAt))) {
      return { ok: false, error: "bad expireAt", hint: "expireAt must be an ISO timestamp, e.g. 2026-12-31T23:59:59Z" };
    }
    expireAtMs = Date.parse(input.expireAt);
  }
  let maxRuns: number | null = null;
  if (input.maxRuns !== undefined) {
    if (typeof input.maxRuns !== "number" || !Number.isInteger(input.maxRuns) || input.maxRuns < 1) {
      return { ok: false, error: "bad maxRuns", hint: "maxRuns must be an integer >= 1" };
    }
    maxRuns = input.maxRuns;
  }
  const active = readScalar<number>(sql, "SELECT COUNT(*) AS n FROM pi_routines WHERE ws = ? AND next_run_at IS NOT NULL", ws) ?? 0;
  if (active >= MAX_ACTIVE_ROUTINES) {
    return { ok: false, error: "too many active routines", hint: `at most ${MAX_ACTIVE_ROUTINES} active routines per workspace; delete one or let one expire` };
  }
  const id = crypto.randomUUID();
  const minIntervalS = input.kind === "interval" ? Number(input.spec) : null;
  sql.exec(
    "INSERT INTO pi_routines(ws, id, sid, schedule_kind, schedule_spec, prompt, next_run_at, expire_at, max_runs, run_count, min_interval_s, created_by, last_request_id, claim_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)",
    ws,
    id,
    sid,
    input.kind,
    input.spec,
    input.prompt,
    first.atMs,
    expireAtMs,
    maxRuns,
    minIntervalS,
    input.createdBy ?? "api",
    input.requestId ?? null,
  );
  rearmRoutines(sql);
  return { ok: true, routine: getRoutine(sql, ws, id) as RoutineRow };
}

function getRoutineByRequest(sql: EntriesSql, ws: string, requestId: string): RoutineRow | null {
  return toRoutineRow(readSingleRow(sql, `${SELECT_ROUTINE} WHERE ws = ? AND last_request_id = ? LIMIT 1`, ws, requestId));
}

export function deleteRoutine(sql: EntriesSql, ws: string, id: string): boolean {
  ensureRoutinesSchema(sql);
  if (getRoutine(sql, ws, id) === null) return false;
  sql.exec("DELETE FROM pi_routines WHERE ws = ? AND id = ?", ws, id);
  rearmRoutines(sql);
  return true;
}

export interface RoutineClaim {
  claimed: boolean;
  routine: RoutineRow | null;
}

// Single-owner fire: the compare-and-set is the whole claim. A caller that
// saw claim_epoch N loses as soon as another claim bumped it; the re-read
// confirms the winner because the UPDATE matched exactly one row only for
// the epoch it guarded.
export function claimRoutine(sql: EntriesSql, id: string, seenEpoch: number, nowMs: number): RoutineClaim {
  const row = readSingleRow(sql, `${SELECT_ROUTINE} WHERE id = ? LIMIT 1`, id);
  const routine = toRoutineRow(row);
  if (routine === null || routine.nextRunAtMs === null || routine.nextRunAtMs > nowMs || routine.claimEpoch !== seenEpoch) {
    return { claimed: false, routine };
  }
  const next = nextRunAfter(routine.scheduleKind, routine.scheduleSpec, nowMs);
  const exhausted = routine.maxRuns !== null && routine.runCount + 1 >= routine.maxRuns;
  sql.exec(
    "UPDATE pi_routines SET next_run_at = ?, claim_epoch = claim_epoch + 1, run_count = run_count + 1 WHERE id = ? AND claim_epoch = ?",
    exhausted ? null : next,
    id,
    seenEpoch,
  );
  const after = readSingleRow(sql, "SELECT claim_epoch AS claimEpoch FROM pi_routines WHERE id = ? LIMIT 1", id);
  const claimed = after !== null && typeof after.claimEpoch === "number" && after.claimEpoch === seenEpoch + 1;
  return { claimed, routine };
}

function dueRoutines(sql: EntriesSql, nowMs: number): RoutineRow[] {
  const out: RoutineRow[] = [];
  for (const row of sql.exec(`${SELECT_ROUTINE} WHERE next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`, nowMs)) {
    const parsed = toRoutineRow(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// Alarm body: claim every due row, then enqueue each winner through the
// session's own turn pipeline. Always rearms so the next fire is armed even
// when nothing was due (a create may have landed while the alarm ran).
// Expired routines stop firing but keep their row for audit: the sweep just
// nulls next_run_at. Runs before the due scan so a due-and-expired row never
// fires its last beat.
export async function fireDueRoutines(sql: EntriesSql, nowMs: number, fire: (routine: RoutineRow) => Promise<void>): Promise<string[]> {
  ensureRoutinesSchema(sql);
  sql.exec("UPDATE pi_routines SET next_run_at = NULL WHERE expire_at IS NOT NULL AND expire_at <= ? AND next_run_at IS NOT NULL", nowMs);
  const fired: string[] = [];
  for (const row of dueRoutines(sql, nowMs)) {
    const claim = claimRoutine(sql, row.id, row.claimEpoch, nowMs);
    if (!claim.claimed) continue;
    fired.push(row.id);
    await fire(row);
  }
  rearmRoutines(sql);
  return fired;
}
