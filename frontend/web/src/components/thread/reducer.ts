// Thread row reduction: pure machinery turning entry rows (replay rows and
// live WS frames alike) into the per-turn view state. Split from useThread
// so the hook owns only sockets, paging, and dispatch.
//
// Delta accumulation folds text/thinking deltas per runId into full strings;
// children receive the FULL strings (never per-token props). Replay and live
// frames share one reducer so a reload renders the identical thread.

import {
  deltaOf,
  keylessPlanPresent,
  parseBody,
  runIdOf,
  type EntryRow,
  type PendingPrompt,
  type TurnViewState,
} from "./types";

export interface ThreadState {
  order: string[];
  byId: Record<string, TurnViewState>;
  pending: PendingPrompt[];
}

export type Action =
  | { kind: "resume"; rows: EntryRow[] }
  | { kind: "live"; row: EntryRow }
  | { kind: "hint"; message: string; hint: string }
  | { kind: "abort"; runId: string }
  | { kind: "toolUpdate"; runId: string; id: string; text: string }
  | { kind: "drop" }
  | { kind: "settle" }
  | { kind: "pend"; id: number; text: string };

function emptyTurn(runId: string): TurnViewState {
  return {
    runId,
    prompt: "",
    parts: [],
    startedAt: null,
    endedAt: null,
    steers: [],
    calls: [],
    status: "streaming",
    error: null,
    halt: null,
    hint: null,
    keyless: false,
    live: false,
  };
}

interface Mutable {
  order: string[];
  byId: Record<string, TurnViewState>;
  pending: PendingPrompt[];
  thinkingStartedAt: Record<string, number>;
}

function draftOf(state: ThreadState, startedAt: Record<string, number>): Mutable {
  const byId: Record<string, TurnViewState> = {};
  for (const [runId, turn] of Object.entries(state.byId)) {
    byId[runId] = { ...turn, parts: turn.parts.map((p) => ({ ...p })), steers: [...turn.steers], calls: turn.calls.map((c) => ({ ...c })) };
  }
  return { order: [...state.order], byId, pending: [...state.pending], thinkingStartedAt: { ...startedAt } };
}

function ensure(m: Mutable, runId: string): TurnViewState {
  let turn = m.byId[runId];
  if (!turn) {
    turn = emptyTurn(runId);
    m.byId[runId] = turn;
    m.order.push(runId);
  }
  return turn;
}

/** Stamp a still-open thinking part with its measured wall time (live only;
 * replayed turns have no wall clock, so they stay ms-less). */
function closeThinking(m: Mutable, turn: TurnViewState): void {
  const tail = turn.parts[turn.parts.length - 1];
  if (!tail || tail.type !== "thinking" || tail.ms !== null) return;
  const started = m.thinkingStartedAt[turn.runId];
  if (started === undefined) return;
  delete m.thinkingStartedAt[turn.runId];
  const ms = Date.now() - started;
  // Sub-second means we don't know the real duration: show none.
  if (ms >= 1000) tail.ms = ms;
}

/** Stamp the turn's end wall-clock once it leaves streaming (live only). */
function closeTurn(turn: TurnViewState): void {
  if (turn.startedAt !== null && turn.endedAt === null) turn.endedAt = Date.now();
}

/** Append a thinking/text delta: tail part of the same kind absorbs it, a
 * kind change closes the tail and opens a new part. A thinking tail whose
 * clock was closed by a row-making event (tool call/result between two
 * reasoning rounds) also opens a fresh part — synara's split rule. */
function appendPart(m: Mutable, runId: string, kind: "thinking" | "text", delta: string): void {
  const turn = ensure(m, runId);
  const tail = turn.parts[turn.parts.length - 1];
  const tailOpen = tail !== undefined && m.thinkingStartedAt[runId] !== undefined;
  if (tail && tail.type === kind && (kind === "text" || tailOpen)) {
    tail.text += delta;
    return;
  }
  if (tail) closeThinking(m, turn);
  turn.parts.push(kind === "thinking" ? { type: kind, text: delta, ms: null } : { type: kind, text: delta });
  if (kind === "thinking") m.thinkingStartedAt[runId] = Date.now();
}

/** File a tool call under the tail tools part, opening one after any content
 * part — calls made between two text/thinking blocks stack as one group
 * (t3-web per-segment stacking). Call views stay in turn.calls so a
 * toolResult can correlate by id regardless of part. */
function appendToolCall(m: Mutable, runId: string, id: string): void {
  const turn = ensure(m, runId);
  closeThinking(m, turn);
  const tail = turn.parts[turn.parts.length - 1];
  if (tail && tail.type === "tools") tail.ids.push(id);
  else turn.parts.push({ type: "tools", ids: [id] });
}

function consumePending(m: Mutable, prompt: string): void {
  const idx = m.pending.findIndex((p) => p.text === prompt);
  if (idx >= 0) m.pending.splice(idx, 1);
}

function applyRow(m: Mutable, row: EntryRow): void {
  const body = parseBody(row.body);
  switch (row.type) {
    case "prompt": {
      const runId = runIdOf(body);
      const prompt = body["prompt"];
      if (runId === null || typeof prompt !== "string" || prompt.length === 0) return;
      const turn = ensure(m, runId);
      turn.prompt = prompt;
      if (turn.startedAt === null) turn.startedAt = Date.now();
      consumePending(m, prompt);
      return;
    }
    case "text": {
      const runId = runIdOf(body);
      const delta = deltaOf(body);
      if (runId === null || delta === null) return;
      appendPart(m, runId, "text", delta.replace(/<\/?think>/g, ""));
      return;
    }
    case "thinking": {
      const runId = runIdOf(body);
      const delta = deltaOf(body);
      if (runId === null || delta === null) return;
      appendPart(m, runId, "thinking", delta);
      return;
    }
    case "toolCall": {
      const runId = runIdOf(body);
      const id = body["id"];
      const tool = body["tool"];
      if (runId === null || typeof id !== "string" || typeof tool !== "string") return;
      const turn = ensure(m, runId);
      const existing = turn.calls.find((c) => c.id === id);
      if (existing === undefined) {
        turn.calls.push({ id, tool, args: body["args"] ?? null, output: null, done: false });
        // Row-making event: close open thinking, stack the call in the tail
        // tools segment (synara split rule + t3-web per-segment grouping).
        appendToolCall(m, runId, id);
      } else if (existing.tool === "tool" && existing.args === null && !existing.done) {
        // A live toolUpdate placeholder landed before the persisted row
        // (heal race): keep its partial output, fill in the real identity.
        existing.tool = tool;
        existing.args = body["args"] ?? null;
      }
      // Both keyless-plan steps on one turn means it ran without a provider
      // key; TurnView blocks it instead of rendering harness output.
      if (keylessPlanPresent(turn.calls)) turn.keyless = true;
      return;
    }
    case "toolResult": {
      const runId = runIdOf(body);
      const id = body["id"];
      if (runId === null || typeof id !== "string") return;
      const turn = ensure(m, runId);
      closeThinking(m, turn);
      const output = body["output"];
      const text = typeof output === "string" ? output : null;
      const call = turn.calls.find((c) => c.id === id);
      if (call) {
        call.output = text;
        call.done = true;
      } else {
        turn.calls.push({
          id,
          tool: typeof body["tool"] === "string" ? body["tool"] : "tool",
          args: body["args"] ?? null,
          output: text,
          done: true,
        });
      }
      if (keylessPlanPresent(turn.calls)) turn.keyless = true;
      return;
    }
    case "result": {
      const runId = runIdOf(body);
      if (runId === null) return;
      const turn = ensure(m, runId);
      turn.status = "done";
      // A budget halt rides the result body: the turn finished, but its
      // output is visibly incomplete, so surface the reason.
      const halt = body["halt"];
      if (halt !== null && typeof halt === "object" && !Array.isArray(halt)) {
        const reason = (halt as Record<string, unknown>)["reason"];
        if (typeof reason === "string" && reason.length > 0) turn.halt = reason;
      }
      closeThinking(m, turn);
      closeTurn(turn);
      return;
    }
    case "error": {
      const runId = runIdOf(body);
      if (runId === null) return;
      const turn = ensure(m, runId);
      turn.status = "error";
      const message = body["error"];
      turn.error = typeof message === "string" && message.length > 0 ? message : "Turn failed";
      const hint = body["hint"];
      if (typeof hint === "string" && hint.length > 0) turn.hint = hint;
      closeThinking(m, turn);
      closeTurn(turn);
      return;
    }
    case "interrupted": {
      const runId = runIdOf(body);
      if (runId === null) return;
      const turn = ensure(m, runId);
      if (turn.status === "streaming") turn.status = "interrupted";
      closeThinking(m, turn);
      closeTurn(turn);
      return;
    }
    case "steer": {
      const runId = runIdOf(body);
      const text = body["text"];
      if (runId === null || typeof text !== "string" || text.length === 0) return;
      ensure(m, runId).steers.push(text);
      return;
    }
    default:
      // Session-level rows (model/thinking switches, compaction, usage) and
      // unknown future types never render as turn content.
      return;
  }
}

export function reducer(
  state: ThreadState,
  startedAt: Record<string, number>,
  action: Action,
): { state: ThreadState; startedAt: Record<string, number> } {
  const m = draftOf(state, startedAt);
  switch (action.kind) {
    case "resume":
      for (const row of action.rows) applyRow(m, row);
      break;
    case "live": {
      applyRow(m, action.row);
      const liveId = runIdOf(parseBody(action.row.body));
      if (liveId !== null && m.byId[liveId]) m.byId[liveId].live = true;
      break;
    }
    case "hint": {
      // Bare {error, hint} frames carry no runId; they trail the persisted
      // error entry, so attach to the latest errored turn still missing one.
      for (let i = m.order.length - 1; i >= 0; i--) {
        const turn = m.byId[m.order[i]];
        if (turn && turn.status === "error" && turn.hint === null) {
          turn.hint = action.hint;
          break;
        }
      }
      break;
    }
    case "abort": {
      const turn = m.byId[action.runId];
      if (turn && turn.status === "streaming") {
        turn.status = "interrupted";
        closeThinking(m, turn);
      }
      break;
    }
    case "toolUpdate": {
      // Live-only throttled partial output for a running tool call; folds
      // into the matching call view keyed by runId+id. The persisted
      // toolCall row may not have landed yet (heal race), so a missing
      // call opens a placeholder that the row later fills in.
      // The prompt row may itself be gap-buffered, so ensure the turn
      // exists rather than dropping the update.
      const turn = ensure(m, action.runId);
      let call = turn.calls.find((c) => c.id === action.id);
      if (call === undefined) {
        call = { id: action.id, tool: "tool", args: null, output: null, done: false };
        turn.calls.push(call);
        appendToolCall(m, action.runId, action.id);
      }
      call.output = (call.output ?? "") + action.text;
      turn.live = true;
      break;
    }
    case "drop": {
      // Socket died: the server aborts the live turn on its side, so mirror
      // it here instead of leaving turns streaming forever. Reconnect syncs
      // the persisted interrupted/result rows.
      for (const runId of m.order) {
        const turn = m.byId[runId];
        if (turn && turn.status === "streaming") {
          turn.status = "interrupted";
          closeThinking(m, turn);
        }
      }
      break;
    }
    case "settle": {
      // Post-replay truth: a streaming turn no live frame touched is an
      // orphaned open run (dead before any terminal entry persisted), not
      // a live turn. Settle it so Stop/Retry have something real to act on.
      for (const runId of m.order) {
        const turn = m.byId[runId];
        if (turn && turn.status === "streaming" && !turn.live) {
          turn.status = "interrupted";
          closeThinking(m, turn);
        }
      }
      break;
    }
    case "pend":
      m.pending.push({ id: action.id, text: action.text });
      break;
  }
  return { state: { order: m.order, byId: m.byId, pending: m.pending }, startedAt: m.thinkingStartedAt };
}

export const initial: ThreadState = { order: [], byId: {}, pending: [] };
