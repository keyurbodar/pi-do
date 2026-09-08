// useThread — owns thread state for one session: resume from GET entries,
// live deltas over the session WS, and prompt dispatch.
//
// Delta accumulation lives here in the parent: text/thinking deltas per
// runId fold into full strings, and children receive the FULL strings (never
// per-token props). Replay and live frames share one reducer so a reload
// renders the identical thread.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { workerBaseUrl } from "../../lib/hc-client";
import {
  deltaOf,
  keylessPlanPresent,
  parseBody,
  runIdOf,
  type ConnState,
  type EntryRow,
  type PendingPrompt,
  type SessionRef,
  type TurnViewState,
} from "./types";

interface ThreadState {
  order: string[];
  byId: Record<string, TurnViewState>;
  pending: PendingPrompt[];
}

type Action =
  | { kind: "resume"; rows: EntryRow[] }
  | { kind: "live"; row: EntryRow }
  | { kind: "hint"; message: string; hint: string }
  | { kind: "abort"; runId: string }
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
      if (!turn.calls.some((c) => c.id === id)) {
        turn.calls.push({ id, tool, args: body["args"] ?? null, output: null, done: false });
        // Row-making event: close open thinking, stack the call in the tail
        // tools segment (synara split rule + t3-web per-segment grouping).
        appendToolCall(m, runId, id);
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

function reducer(
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

const initial: ThreadState = { order: [], byId: {}, pending: [] };

function streamUrl(session: SessionRef): string {
  const base = workerBaseUrl().replace(/^http/, "ws");
  return `${base}/workspaces/${session.workspaceId}/sessions/${session.sessionId}/stream`;
}

export interface ThreadApi {
  turns: TurnViewState[];
  pending: PendingPrompt[];
  conn: ConnState;
  send: (text: string) => void;
  abort: () => void;
  running: boolean;
}

export function useThread(session: SessionRef): ThreadApi {
  const [pair, dispatch] = useReducer(
    (prev: { state: ThreadState; startedAt: Record<string, number> }, action: Action) =>
      reducer(prev.state, prev.startedAt, action),
    { state: initial, startedAt: {} },
  );
  const [conn, setConn] = useState<ConnState>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<string[]>([]);
  const seenRef = useRef<Set<number>>(new Set());
  const pendIdRef = useRef(0);
  const cancelledRef = useRef(false);

  const flush = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (next === undefined) break;
      ws.send(JSON.stringify({ prompt: next }));
    }
  }, []);

  // (Re)opens the session socket; a no-op while one is open or connecting so
  // Retry after a drop dials a fresh socket before re-queueing the prompt.
  const connect = useCallback(() => {
    const live = wsRef.current;
    if (live && (live.readyState === WebSocket.OPEN || live.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket(streamUrl(session));
    wsRef.current = ws;
    ws.onopen = () => {
      if (cancelledRef.current) {
        ws.close();
        return;
      }
      setConn("open");
      // Reconnect heal: pull entries past the max seen cursor so rows
      // persisted while the socket was down (interrupted/result) land.
      (async () => {
        try {
          let max = 0;
          for (const cursor of seenRef.current) if (cursor > max) max = cursor;
          const url = new URL(
            `${workerBaseUrl()}/workspaces/${session.workspaceId}/sessions/${session.sessionId}/entries`,
          );
          url.searchParams.set("after", String(max));
          // Delta-per-row storage means long turns cost thousands of rows;
          // keep the window wide so early history isn't drowned out.
          url.searchParams.set("limit", "5000");
          const res = await fetch(url.toString());
          if (cancelledRef.current || !res.ok) return;
          const data = (await res.json()) as { entries?: EntryRow[] };
          const rows = Array.isArray(data.entries) ? data.entries : [];
          // Unconditional apply double-counts: StrictMode remounts and live
          // frames racing the fetch both deliver rows already reduced.
          const fresh = rows.filter((row) => {
            if (seenRef.current.has(row.cursor)) return false;
            seenRef.current.add(row.cursor);
            return true;
          });
          if (fresh.length > 0) dispatch({ kind: "resume", rows: fresh });
        } catch {
          // Sync failure leaves live frames to catch up.
        }
        if (!cancelledRef.current) flush();
      })();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (cancelledRef.current) return;
      let msg: unknown = null;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
      const rec = msg as Record<string, unknown>;
      if ("entry" in rec && rec["entry"] !== null && typeof rec["entry"] === "object") {
        const row = rec["entry"] as EntryRow;
        if (typeof row.cursor !== "number" || typeof row.type !== "string" || typeof row.body !== "string") return;
        if (seenRef.current.has(row.cursor)) return;
        seenRef.current.add(row.cursor);
        dispatch({ kind: "live", row: { cursor: row.cursor, parent: 0, type: row.type, body: row.body } });
        return;
      }
      if (rec["aborted"] === true && typeof rec["runId"] === "string") {
        dispatch({ kind: "abort", runId: rec["runId"] });
        return;
      }
      if (typeof rec["error"] === "string") {
        const hint = typeof rec["hint"] === "string" ? rec["hint"] : "";
        if (hint.length > 0) dispatch({ kind: "hint", message: rec["error"], hint });
      }
    };
    const dropped = () => {
      if (cancelledRef.current) return;
      if (wsRef.current === ws) wsRef.current = null;
      setConn("closed");
      dispatch({ kind: "drop" });
    };
    ws.onclose = dropped;
    ws.onerror = dropped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspaceId, session.sessionId, flush]);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text.length === 0) return;
      pendIdRef.current += 1;
      dispatch({ kind: "pend", id: pendIdRef.current, text });
      queueRef.current.push(text);
      connect();
      flush();
    },
    [connect, flush],
  );

  useEffect(() => {
    cancelledRef.current = false;
    const seen = seenRef.current;
    setConn("connecting");

    // Resume first: GET entries replays history; the socket opens once the
    // replay lands so live deltas append after, in order.
    (async () => {
      try {
        const url = new URL(
          `${workerBaseUrl()}/workspaces/${session.workspaceId}/sessions/${session.sessionId}/entries`,
        );
        url.searchParams.set("after", "0");
        url.searchParams.set("limit", "5000");
        // GET entries is unvalidated server-side, so the hc client types no
        // query here; plain fetch carries the replay slice instead.
        const res = await fetch(url.toString());
        if (cancelledRef.current) return;
        if (res.ok) {
          const data = (await res.json()) as { entries?: EntryRow[] };
          const rows = Array.isArray(data.entries) ? data.entries : [];
          const fresh = rows.filter((row) => {
            if (seen.has(row.cursor)) return false;
            seen.add(row.cursor);
            return true;
          });
          dispatch({ kind: "resume", rows: fresh });
          // Mount-only: settle replay orphans now, before any live turn can
          // exist. Reconnects must NOT settle — a reconnected turn may still
          // be legitimately streaming its first frames.
          dispatch({ kind: "settle" });
        }
      } catch {
        // Replay failure leaves an empty thread; live frames still append.
      }
      if (!cancelledRef.current) connect();
    })();

    return () => {
      cancelledRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [session.workspaceId, session.sessionId, connect]);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ abort: true }));
      return;
    }
    // Dead socket: the server already interrupted the orphan; dial fresh so
    // the reconnect sync pulls the persisted rows and the UI settles.
    dispatch({ kind: "drop" });
    connect();
  }, [connect]);

  const turns = pair.state.order.map((runId) => pair.state.byId[runId]).filter(Boolean);
  return {
    turns,
    pending: pair.state.pending,
    conn,
    send,
    abort,
    running: turns.some((turn) => turn.status === "streaming"),
  };
}
