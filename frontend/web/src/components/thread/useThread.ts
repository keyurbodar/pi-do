// useThread — owns thread state for one session: resume from GET entries,
// live deltas over the session WS, and prompt dispatch. Row reduction (the
// pure entry-row → view-state machinery) lives in ./reducer.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { workerBaseUrl } from "../../lib/hc-client";
import { initial, reducer, type Action, type ThreadState } from "./reducer";
import {
  type ConnState,
  type EntryRow,
  type PendingPrompt,
  type SessionRef,
  type TurnViewState,
} from "./types";

function streamUrl(session: SessionRef): string {
  const base = workerBaseUrl().replace(/^http/, "ws");
  return `${base}/workspaces/${session.workspaceId}/sessions/${session.sessionId}/stream`;
}

// The server clamps /entries pages to 1000 rows, and delta-per-row storage
// means long turns cost thousands of rows — so replay and reconnect heal
// both page until a short page or head instead of one wide request.
const ENTRY_PAGE = 1000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

/** Pull every entry past `after` in server-clamped pages, handing each page
 * to `take` in cursor order. Throws on a failed page so callers can decide
 * whether to retry or leave live frames to catch up. */
async function fetchEntriesAfter(session: SessionRef, after: number, take: (rows: EntryRow[]) => void): Promise<void> {
  let cursor = after;
  for (;;) {
    const url = new URL(
      `${workerBaseUrl()}/workspaces/${session.workspaceId}/sessions/${session.sessionId}/entries`,
    );
    url.searchParams.set("after", String(cursor));
    url.searchParams.set("limit", String(ENTRY_PAGE));
    // GET entries is unvalidated server-side, so the hc client types no
    // query here; plain fetch carries the replay slice instead.
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`entries ${res.status}`);
    const data = (await res.json()) as { entries?: EntryRow[]; head?: number };
    const rows = Array.isArray(data.entries) ? data.entries : [];
    if (rows.length === 0) return;
    take(rows);
    const last = rows[rows.length - 1].cursor;
    if (rows.length < ENTRY_PAGE || last <= cursor || (typeof data.head === "number" && last >= data.head)) return;
    cursor = last;
  }
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
  const seenRef = useRef<Set<number>>(new Set());
  // Ordered apply: max cursor applied so far, plus live rows buffered
  // behind a gap (a heal page racing live frames) until it fills.
  const maxSeenRef = useRef(0);
  const gapRef = useRef<Map<number, EntryRow>>(new Map());
  const backoffRef = useRef(RECONNECT_MIN_MS);
  const reconnectRef = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const pendIdRef = useRef(0);
  const cancelledRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<string[]>([]);

  const flush = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (next === undefined) break;
      ws.send(JSON.stringify({ prompt: next }));
    }
  }, []);

  // Apply buffered live rows in cursor order once the gap ahead of them
  // fills; seenRef keeps the drain idempotent against rows the heal fetch
  // already delivered.
  const drainGap = useCallback(() => {
    for (;;) {
      const buffered = gapRef.current.get(maxSeenRef.current + 1);
      if (buffered === undefined) break;
      gapRef.current.delete(buffered.cursor);
      if (seenRef.current.has(buffered.cursor)) continue;
      seenRef.current.add(buffered.cursor);
      maxSeenRef.current = buffered.cursor;
      dispatch({ kind: "live", row: buffered });
    }
  }, []);

  // Merge replay/heal rows by cursor: dedupe against everything already
  // applied (StrictMode remounts, live frames racing the fetch), advance
  // the ordered-apply watermark, then drain any buffered live rows the
  // fetch just unblocked.
  const ingestRows = useCallback((rows: EntryRow[]) => {
    const fresh = rows.filter((row) => {
      gapRef.current.delete(row.cursor);
      if (seenRef.current.has(row.cursor)) return false;
      seenRef.current.add(row.cursor);
      if (row.cursor > maxSeenRef.current) maxSeenRef.current = row.cursor;
      return true;
    });
    if (fresh.length > 0) dispatch({ kind: "resume", rows: fresh });
    drainGap();
  }, [drainGap]);

  // Ordered live apply: a row at the next cursor applies now; one further
  // out buffers until the heal fetch fills the gap ahead of it.
  const acceptLiveRow = useCallback(
    (row: EntryRow) => {
      if (seenRef.current.has(row.cursor)) return;
      if (row.cursor !== maxSeenRef.current + 1) {
        gapRef.current.set(row.cursor, row);
        return;
      }
      seenRef.current.add(row.cursor);
      maxSeenRef.current = row.cursor;
      dispatch({ kind: "live", row });
      drainGap();
    },
    [drainGap],
  );

  // (Re)opens the session socket; a no-op while one is open or connecting so
  // Retry after a drop dials a fresh socket before re-queueing the prompt.
  const connect = useCallback(() => {
    const live = wsRef.current;
    if (live && (live.readyState === WebSocket.OPEN || live.readyState === WebSocket.CONNECTING)) return;
    setConn("connecting");
    const ws = new WebSocket(streamUrl(session));
    wsRef.current = ws;
    ws.onopen = () => {
      if (cancelledRef.current) {
        ws.close();
        return;
      }
      // Clean open: restart the reconnect backoff.
      backoffRef.current = RECONNECT_MIN_MS;
      setConn("open");
      // Heal: page entries past the max seen cursor so rows persisted
      // while the socket was down (interrupted/result) land; live frames
      // racing the fetch buffer behind the gap until the pages fill it.
      (async () => {
        try {
          await fetchEntriesAfter(session, maxSeenRef.current, ingestRows);
        } catch {
          // Heal failure leaves the gap buffer to order live frames.
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
        acceptLiveRow({ cursor: row.cursor, parent: 0, type: row.type, body: row.body });
        return;
      }
      if (rec["live"] !== null && typeof rec["live"] === "object" && !Array.isArray(rec["live"])) {
        // Live-only frame (no cursor, never persisted): throttled partial
        // output for a running tool call.
        const liveFrame = rec["live"] as Record<string, unknown>;
        if (
          liveFrame["kind"] === "toolUpdate" &&
          typeof liveFrame["runId"] === "string" &&
          typeof liveFrame["id"] === "string" &&
          typeof liveFrame["text"] === "string"
        ) {
          dispatch({ kind: "toolUpdate", runId: liveFrame["runId"], id: liveFrame["id"], text: liveFrame["text"] });
        }
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
      if (wsRef.current === ws) wsRef.current = null;
      if (cancelledRef.current) return;
      setConn("closed");
      dispatch({ kind: "drop" });
      // Abnormal close: reconnect with doubling backoff (500ms → 5s cap)
      // for as long as the page stays open. Seen cursors and the gap
      // buffer survive the drop, so the heal catches up without dupes.
      if (reconnectRef.current !== null) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(backoffRef.current * 2, RECONNECT_MAX_MS);
      reconnectRef.current = window.setTimeout(() => {
        reconnectRef.current = null;
        if (!cancelledRef.current) connectRef.current();
      }, delay);
    };
    ws.onclose = dropped;
    ws.onerror = dropped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspaceId, session.sessionId, flush, ingestRows, acceptLiveRow]);

  // Keep the ref current so the reconnect timer always dials the latest
  // connect closure without re-arming on every render.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

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
    setConn("connecting");

    // Resume first: GET entries replays history (paged to the server's
    // 1000-row clamp so >1000-entry sessions replay fully); the socket
    // opens once the replay lands so live deltas append after, in order.
    (async () => {
      try {
        await fetchEntriesAfter(session, 0, ingestRows);
        // Mount-only: settle replay orphans now, before any live turn can
        // exist. Reconnects must NOT settle — a reconnected turn may still
        // be legitimately streaming its first frames.
        dispatch({ kind: "settle" });
      } catch {
        // Replay failure leaves an empty thread; live frames still append.
      }
      if (!cancelledRef.current) connect();
    })();

    return () => {
      cancelledRef.current = true;
      if (reconnectRef.current !== null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [session.workspaceId, session.sessionId, connect, ingestRows]);

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
