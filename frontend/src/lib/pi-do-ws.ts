/**
 * pi-do wire seam. Shared vocabulary plus the resume contract.
 *
 * Frames: `{entry: {cursor, parent, type, body}}` per append, then
 * `{done: true, fence, revision}` with a rotated fence. Unknown sessions
 * close with 4404; stale sockets close with 4403/4409.
 *
 * Resume (replay; storage is the truth, the socket is a view):
 * 1. `GET /meta` yields the current `{fence, revision}`.
 * 2. `GET /entries?after=<cursor>` replays missed entries.
 * 3. `connect` with the fresh fence.
 *
 * Entry types mirror the eight kinds projected by
 * `packages/pi-cf/src/context.ts` (`buildSessionContext`); storage rows
 * with other types (e.g. `interrupted`, `error`) project as skipped there.
 * `compareFence`/`rotateFence` are pure: no I/O, no timers, no DOM.
 * Rotation advances the revision by one, matching `enforceFence` and the
 * mid-turn rotation in `worker/src/stream.ts`; the caller supplies the
 * fresh fence token, so no randomness lives in here.
 *
 * The socket URL is same-origin `/stream`, derived from `PI_DO_URL`
 * by swapping the scheme to ws/wss. Full client lands next phase.
 */

export type EntryType =
  | 'prompt'
  | 'result'
  | 'toolCall'
  | 'toolResult'
  | 'compaction'
  | 'steer'
  | 'model_change'
  | 'thinking_level_change';

/** Row-kind union consumed by the timeline mapper; one kind per entry. */
export type RowKind = EntryType;

export interface Entry {
  cursor: number;
  parent: number;
  type: EntryType;
  body: unknown;
}

export interface FenceState {
  fence: string;
  revision: number;
}

const ENTRY_TYPES: readonly EntryType[] = [
  'prompt',
  'result',
  'toolCall',
  'toolResult',
  'compaction',
  'steer',
  'model_change',
  'thinking_level_change',
];

export function isEntryType(value: unknown): value is EntryType {
  return (
    typeof value === 'string' &&
    (ENTRY_TYPES as readonly string[]).includes(value)
  );
}

export type FenceOrder = 'stale' | 'behind' | 'current' | 'ahead';

export function compareFence(held: FenceState, seen: FenceState): FenceOrder {
  if (held.fence !== seen.fence) return 'stale';
  if (seen.revision < held.revision) return 'behind';
  if (seen.revision > held.revision) return 'ahead';
  return 'current';
}

export function rotateFence(current: FenceState, nextFence: string): FenceState {
  if (nextFence.length === 0) {
    throw new Error('pi-do-ws: rotateFence needs a non-empty fence');
  }
  if (!Number.isInteger(current.revision) || current.revision < 0) {
    throw new Error('pi-do-ws: rotateFence needs an integer revision >= 0');
  }
  return { fence: nextFence, revision: current.revision + 1 };
}

export interface PiDoSocket {
  close(): void;
}

export interface ConnectOptions {
  workspace: string;
  session: string;
  fence: FenceState;
}

function shell(): never {
  throw new Error('pi-do-ws: shell only, client lands next phase');
}

export function connect(_options: ConnectOptions): PiDoSocket {
  shell();
}

export function disconnect(_socket: PiDoSocket | null | undefined): void {
  // Shell: nothing to close yet; real sockets close here next phase.
}
