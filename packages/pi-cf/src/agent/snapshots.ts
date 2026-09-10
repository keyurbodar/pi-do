export interface SnapshotEvent {
  seq: number; type: "runStart" | "runEnd"; sid: string; at: string;
  prompt?: string; ok?: boolean; error?: string;
}

export interface SessionSnapshot {
  sid: string; status: "idle" | "running"; seq: number;
  run: { prompt: string; startedAt: string } | null;
  last: { prompt: string; startedAt: string; endedAt: string; ok: boolean } | null;
}

interface BusState {
  seq: number; status: "idle" | "running";
  run: { prompt: string; startedAt: string } | null;
  last: { prompt: string; startedAt: string; endedAt: string; ok: boolean } | null;
  events: SnapshotEvent[];
}

const MAX_EVENTS = 50;
const states = new Map<string, BusState>();

function stateFor(sid: string): BusState {
  const found = states.get(sid);
  if (found !== undefined) return found;
  const fresh: BusState = { seq: 0, status: "idle", run: null, last: null, events: [] };
  states.set(sid, fresh);
  return fresh;
}

function push(state: BusState, event: Omit<SnapshotEvent, "seq">): void {
  state.seq += 1;
  state.events.push({ ...event, seq: state.seq });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

// Run start arms the snapshot and returns the run-end emitter, so the
// session hook stays one start line plus its terminal returns.
export function emitRunStart(sid: string, prompt: string): <T>(next: Promise<T>) => Promise<T> {
  const state = stateFor(sid);
  const startedAt = new Date().toISOString();
  state.status = "running";
  state.run = { prompt, startedAt };
  push(state, { type: "runStart", sid, at: startedAt, prompt });
  const runEnd = <T>(next: Promise<T>): Promise<T> =>
    next.then(
      (turn) => {
        const endedAt = new Date().toISOString();
        state.status = "idle";
        state.last = { prompt, startedAt, endedAt, ok: true };
        state.run = null;
        push(state, { type: "runEnd", sid, at: endedAt, prompt, ok: true });
        return turn;
      },
      (error) => {
        const endedAt = new Date().toISOString();
        state.status = "idle";
        state.last = { prompt, startedAt, endedAt, ok: false };
        state.run = null;
        push(state, {
          type: "runEnd", sid, at: endedAt, prompt, ok: false,
          ...(error !== null && typeof error === "object" && "error" in error && typeof error.error === "string" ? { error: error.error } : {}),
        });
        throw error;
      },
    );
  return runEnd;
}

export function readSnapshot(sid: string): SessionSnapshot {
  const state = states.get(sid);
  if (state === undefined) return { sid, status: "idle", seq: 0, run: null, last: null };
  return { sid, status: state.status, seq: state.seq, run: state.run, last: state.last };
}

export function readEvents(sid: string, since: number): SnapshotEvent[] {
  const state = states.get(sid);
  if (state === undefined) return [];
  return state.events.filter((event) => event.seq > since);
}
