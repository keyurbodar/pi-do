// Routines client: scheduled durable turns per bot. The routes forward to the
// workspace DO without validators, so plain fetch carries the payloads (same
// shape as session.ts's postForwarded). GET lists every routine in the
// workspace — callers filter by routine.sid for the bot they are showing.
import { workerBaseUrl } from "./hc-client";

export type RoutineKind = "once" | "interval" | "weekly";

export interface Routine {
  id: string;
  sid: string;
  schedule: { kind: string; spec: string };
  prompt: string;
  nextRunAt: string | null;
  expireAt: string | null;
  maxRuns: number | null;
  runCount: number;
  active: boolean;
}

export interface CreateRoutineInput {
  kind: RoutineKind;
  spec: string;
  prompt: string;
  expireAt?: string;
  maxRuns?: number;
  requestId?: string;
}

/** Server rejections carry {error, hint} (bad spec, the 50-active cap); the
 * hint is the actionable half, so it rides the thrown error for inline UI. */
export class RoutineRequestError extends Error {
  readonly status: number;
  readonly hint: string | null;
  constructor(status: number, error: string, hint: string | null) {
    super(error);
    this.status = status;
    this.hint = hint;
  }
}

function routinesPath(ws: string, sid: string): string {
  return `/workspaces/${ws}/sessions/${sid}/routines`;
}

function malformed(what: string): Error {
  return new Error(
    `${what} returned a malformed response: restart the Worker dev server and reload.`,
  );
}

async function readError(res: Response, what: string): Promise<Error> {
  try {
    const body = await res.json();
    if (body !== null && typeof body === "object") {
      const record = body as Record<string, unknown>;
      if (typeof record.error === "string" && record.error.length > 0) {
        const hint = typeof record.hint === "string" && record.hint.length > 0 ? record.hint : null;
        return new RoutineRequestError(res.status, record.error, hint);
      }
    }
  } catch {
    // fall through to the generic failure below
  }
  return new Error(
    `${what} failed with status ${res.status}: start the Worker (npm run dev in worker/) and reload.`,
  );
}

function asRoutine(value: unknown, what: string): Routine {
  if (value === null || typeof value !== "object") throw malformed(what);
  const record = value as Record<string, unknown>;
  const schedule = record.schedule;
  if (schedule === null || typeof schedule !== "object") throw malformed(what);
  const sched = schedule as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.sid !== "string" ||
    typeof sched.kind !== "string" ||
    typeof sched.spec !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.runCount !== "number" ||
    typeof record.active !== "boolean"
  ) {
    throw malformed(what);
  }
  return {
    id: record.id,
    sid: record.sid,
    schedule: { kind: sched.kind, spec: sched.spec },
    prompt: record.prompt,
    nextRunAt: typeof record.nextRunAt === "string" ? record.nextRunAt : null,
    expireAt: typeof record.expireAt === "string" ? record.expireAt : null,
    maxRuns: typeof record.maxRuns === "number" ? record.maxRuns : null,
    runCount: record.runCount,
    active: record.active,
  };
}

/** Every routine in the workspace; filter by r.sid for one bot. */
export async function listRoutines(ws: string, sid: string): Promise<Routine[]> {
  const what = "GET /workspaces/:id/sessions/:sid/routines";
  const res = await fetch(`${workerBaseUrl()}${routinesPath(ws, sid)}`);
  if (!res.ok) throw await readError(res, what);
  const body = await res.json();
  if (body === null || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).routines)) {
    throw malformed(what);
  }
  return ((body as Record<string, unknown>).routines as unknown[]).map((row) => asRoutine(row, what));
}

export async function createRoutine(ws: string, sid: string, input: CreateRoutineInput): Promise<Routine> {
  const what = "POST /workspaces/:id/sessions/:sid/routines";
  const res = await fetch(`${workerBaseUrl()}${routinesPath(ws, sid)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res, what);
  const body = await res.json();
  if (body === null || typeof body !== "object") throw malformed(what);
  return asRoutine((body as Record<string, unknown>).routine, what);
}

export async function deleteRoutine(ws: string, sid: string, id: string): Promise<void> {
  const what = "DELETE /workspaces/:id/sessions/:sid/routines";
  const res = await fetch(`${workerBaseUrl()}${routinesPath(ws, sid)}?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await readError(res, what);
}
