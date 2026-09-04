// stream.ts — hibernation WS handlers for GET /workspaces/:id/sessions/:sid/stream.
// Live turns over a socket: {prompt, fence, expected} in, {entry} frames out.
// Optional {fence, expected} enforces exactly like a prompt.
// Every entry frame is re-read from storage by cursor before emit; the socket
// is a view, pi_entries is the truth. Unknown sessions and failed fences get
// an {error, hint} frame followed by a close frame — never a bare drop.
//
// Hibernation shape: the DO accepts sockets via state.acceptWebSocket and the
// runtime wakes it per message into webSocketMessage/webSocketClose/
// webSocketError. Nothing turn-related lives here across messages — fence,
// revision, entries, and open runs are re-read from SQLite on every wake, so an
// eviction eats no correctness state. The host hands one ephemeral sid ->
// AbortController map per DO incarnation as the abort witness, plus the
// session turn queue shared with POST /run; dropping both on eviction is safe
// because the next openRun flips the orphaned run to interrupted.
import { appendEntry, closeRun, getEntry, openRun, sessionLeaf, type EntriesSql } from "../../packages/pi-cf/src/entries";
import { enforceFence } from "../../packages/pi-cf/src/fence";
import type { FileStore } from "../../packages/pi-cf/src/vfs-dofs";
import { buildRuntime, clampThinkingLevel, keyedProviders, resolveCatalogModel, resolveKeyedModel, resolveProviderKey, type RuntimeEnv, type RuntimeModel } from "./model-runtime";
import { createAgentSession } from "../../packages/pi-cf/src/session";
export interface StreamShell {
  exec(input: {
    command: string;
    cwd?: string;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean }>;
}
export interface StreamHost {
  sql: EntriesSql;
  ws: string;
  sid: string;
  files: FileStore;
  shell: StreamShell;
  runtimeEnv: RuntimeEnv;
  thinking: string | null;
  model: { provider: string; id: string } | null;
  workspaceKnown: boolean;
  sessionKnown: boolean;
  readFence(): { fence: string | null; revision: number } | null;
  casRotateFence(oldFence: string, oldRevision: number, next: { fence: string; revision: number }): boolean;
  live: Map<string, AbortController>;
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface StreamAttachment {
  ws: string;
  sid: string;
}

export interface StreamSocket {
  send(frame: unknown): void;
  close(code: number, reason: string): void;
}

const CLOSE_UNKNOWN = 4404;
const CLOSE_FENCED = 4403;
const CLOSE_CONFLICT = 4409;

function shortReason(hint: string): string {
  return hint.length > 120 ? hint.slice(0, 120) : hint;
}

export function wrapSocket(ws: WebSocket): StreamSocket {
  return {
    send(frame: unknown): void {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // Gone mid-send; the error frame already went out.
      }
    },
    close(code: number, reason: string): void {
      try {
        ws.close(code, shortReason(reason));
      } catch {
        // Gone mid-close; the error frame already went out.
      }
    },
  };
}

export function readAttachment(ws: WebSocket): StreamAttachment | null {
  try {
    const raw: unknown = ws.deserializeAttachment();
    if (raw === null || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec["ws"] !== "string" || rec["ws"].length === 0) return null;
    if (typeof rec["sid"] !== "string" || rec["sid"].length === 0) return null;
    return { ws: rec["ws"] as string, sid: rec["sid"] as string };
  } catch {
    return null;
  }
}

function openRunId(sql: EntriesSql, sid: string): string | null {
  for (const row of sql.exec("SELECT runId FROM runs WHERE sid = ? AND status = ? LIMIT 1", sid, "open")) {
    if (row !== null && typeof row === "object" && "runId" in row && typeof row.runId === "string") {
      return row.runId;
    }
  }
  return null;
}

export function acceptStream(request: Request, host: StreamHost, state: DurableObjectState): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(
      {
        error: "missing upgrade",
        hint: "retry as GET /workspaces/:id/sessions/:sid/stream with an Upgrade: websocket handshake",
      },
      { status: 400 },
    );
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  state.acceptWebSocket(server);
  server.serializeAttachment({ ws: host.ws, sid: host.sid } satisfies StreamAttachment);
  const sock = wrapSocket(server);

  if (!host.workspaceKnown) {
    const hint = "create one with POST /workspaces first, then mint a session";
    sock.send({ error: "unknown workspace", hint });
    sock.close(CLOSE_UNKNOWN, hint);
    return new Response(null, { status: 101, webSocket: client });
  }
  if (!host.sessionKnown) {
    const hint = "mint one with POST /workspaces/:id/sessions first, then retry with that session id";
    sock.send({ error: "unknown session", hint });
    sock.close(CLOSE_UNKNOWN, hint);
    return new Response(null, { status: 101, webSocket: client });
  }

  try {
    const query = new URL(request.url).searchParams;
    if (query.has("fence") || query.has("expected")) {
      const fence = query.get("fence");
      const expected = Number(query.get("expected"));
      if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
        const hint = "retry the stream with both ?fence=F&expected=N from the live session row";
        sock.send({ error: "missing fence", hint });
        sock.close(CLOSE_FENCED, hint);
        return new Response(null, { status: 101, webSocket: client });
      }
      const checked = enforceFence(host.readFence(), fence, expected);
      if ("status" in checked) {
        sock.send(checked.body);
        sock.close(checked.status === 403 ? CLOSE_FENCED : CLOSE_CONFLICT, checked.body.hint);
        return new Response(null, { status: 101, webSocket: client });
      }
    }
  } catch {
    const hint = "could not read the stream handshake; reconnect and retry";
    sock.send({ error: "bad handshake", hint });
    sock.close(CLOSE_FENCED, hint);
    return new Response(null, { status: 101, webSocket: client });
  }

  return new Response(null, { status: 101, webSocket: client });
}

export function socketClosed(host: StreamHost): void {
  // Socket dropped mid-turn: abort the live turn (if this incarnation holds
  // one) so the run row ends interrupted instead of orphaned open. After an
  // eviction there is no live turn here; the next openRun heals the orphan.
  host.live.get(host.sid)?.abort();
}

export async function socketMessage(
  host: StreamHost,
  sock: StreamSocket,
  message: string | ArrayBuffer,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad frame");
    msg = parsed as Record<string, unknown>;
  } catch {
    sock.send({ error: "bad frame", hint: "send JSON like {prompt, fence, expected}, {abort}, or {steer, text}" });
    return;
  }
  const isAbort = msg["abort"] === true || msg["type"] === "abort";
  const steerOn = msg["steer"] === true || msg["type"] === "steer";
  const promptValue = typeof msg["prompt"] === "string"
    ? (msg["prompt"] as string)
    : msg["type"] === "prompt" && typeof msg["text"] === "string"
      ? (msg["text"] as string)
      : undefined;

  if (isAbort) {
    const live = host.live.get(host.sid);
    if (live !== undefined) live.abort();
    else {
      sock.send({ error: "no turn in flight", hint: "send {prompt} first; abort only cancels a running turn" });
    }
    return;
  }
  if (steerOn) {
    const text = msg["text"];
    if (typeof text !== "string" || text.length === 0) {
      sock.send({ error: "missing steer text", hint: "retry as {steer, text} with a non-empty string" });
      return;
    }
    const runId = openRunId(host.sql, host.sid);
    if (runId === null) {
      sock.send({ error: "no turn in flight", hint: "send {prompt} first; steer only appends mid-turn" });
      return;
    }
    const cursor = appendEntry(host.sql, host.sid, "steer", { runId, text });
    const row = getEntry(host.sql, host.sid, cursor);
    if (row !== null) sock.send({ entry: row });
    return;
  }
  if (promptValue !== undefined) {
    if (promptValue.length === 0) {
      sock.send({ error: "missing prompt", hint: 'retry with a non-empty prompt, e.g. {"prompt": "read seed.txt"}' });
      return;
    }
    const hasFence = "fence" in msg || "expected" in msg;
    await startTurn(host, sock, promptValue, msg["fence"], msg["expected"], hasFence);
    return;
  }
  sock.send({ error: "unknown frame", hint: "send {prompt, fence, expected}, {abort}, or {steer, text}" });
}

async function startTurn(
  host: StreamHost,
  sock: StreamSocket,
  prompt: string,
  fence: unknown,
  expected: unknown,
  hasFence: boolean,
): Promise<void> {
  // One prompt per session at a time across POST /run and WS: the queue
  // holds this turn until earlier turns on the sid settle. The live map is
  // only the abort witness; an eviction resets it and the next openRun
  // flips the orphaned run to interrupted, so resume heals.
  await host.enqueue(async () => {
  let held: { fence: string; revision: number } | null = null;
  if (hasFence) {
    if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected) || typeof expected !== "number") {
      sock.send({ error: "missing fence", hint: "retry the turn with both {fence, expected}, or omit both" });
      return;
    }
    const checked = enforceFence(host.readFence(), fence, expected);
    if ("status" in checked) {
      sock.send(checked.body);
      sock.close(checked.status === 403 ? CLOSE_FENCED : CLOSE_CONFLICT, checked.body.hint);
      return;
    }
    held = { fence, revision: expected };
  }
  const turnId = crypto.randomUUID();
  const turnController = new AbortController();
  host.live.set(host.sid, turnController);
  const send = (frame: unknown): void => sock.send(frame);
  const closeSocket = (code: number, reason: string): void => sock.close(code, reason);
  const emitAppend = (type: string, body: unknown): void => {
    const cursor = appendEntry(host.sql, host.sid, type, body);
    const row = getEntry(host.sql, host.sid, cursor);
    if (row !== null) send({ entry: row });
  };
  try {
    const historyLeaf = sessionLeaf(host.sql, host.sid);
    openRun(host.sql, host.sid, turnId);
    emitAppend("prompt", { runId: turnId, prompt });
    const catalog = host.model === null ? null : resolveCatalogModel(host.model.provider, host.model.id);
    let turnModel: { id: string; name?: string; api?: string; provider?: string; baseUrl?: string };
    let respProvider: string;
    let stub: boolean;
    let like: RuntimeModel | Record<string, never>;
    if (catalog === null) {
      const runtime = buildRuntime(host.runtimeEnv);
      turnModel = runtime.model;
      respProvider = runtime.model.provider;
      stub = runtime.stub;
      like = runtime.stub ? {} : runtime.model;
    } else {
      const keyed = keyedProviders(host.runtimeEnv);
      const keyedModel = keyed.length === 0 ? null : resolveKeyedModel(host.runtimeEnv, catalog.provider, catalog.id);
      turnModel = keyedModel ?? { id: catalog.id };
      respProvider = keyedModel?.provider ?? catalog.provider;
      stub = keyedModel === null;
      like = catalog;
    }
    const effThinking = host.thinking === null ? null : clampThinkingLevel(like, host.thinking);
    const session = createAgentSession({
      files: host.files,
      ws: host.ws,
      shell: host.shell,
      model: turnModel,
      apiKey: stub ? undefined : resolveProviderKey(host.runtimeEnv, respProvider),
      history: { leaf: historyLeaf, readEntry: (cursor) => getEntry(host.sql, host.sid, cursor) },
      sessionId: host.sid,
    });
    const turn = await session.run(prompt, {
      signal: turnController.signal,
      thinking: effThinking,
      onUpdate: (event) => {
        if (event.kind === "toolCall") {
          emitAppend("toolCall", { runId: turnId, id: event.id, tool: event.tool, args: event.args });
        } else {
          emitAppend("toolResult", { runId: turnId, id: event.id, tool: event.tool, output: event.output });
        }
      },
    });
    emitAppend("result", { runId: turnId, result: turn.result, usage: turn.usage });
    const runtimeOut = { via: turn.via, model: turn.model, provider: respProvider, thinking: effThinking };
    closeRun(host.sql, host.sid, turnId);
    if (held !== null) {
      const next = { fence: crypto.randomUUID(), revision: held.revision + 1 };
      if (!host.casRotateFence(held.fence, held.revision, next)) {
        const cur = host.readFence();
        send({ error: "revision conflict", hint: "a concurrent holder rotated mid-turn; re-claim and retry", revision: cur?.revision ?? 0 });
        closeSocket(CLOSE_CONFLICT, "concurrent rotation mid-turn");
        return;
      }
      send({ done: true, fence: next.fence, revision: next.revision, result: turn.result, runtime: runtimeOut, usage: turn.usage });
    } else send({ done: true, result: turn.result, runtime: runtimeOut, usage: turn.usage });
  } catch (e) {
    if (turnController.signal.aborted) {
      host.sql.exec(
        "UPDATE runs SET status = ? WHERE sid = ? AND runId = ?",
        "interrupted",
        host.sid,
        turnId,
      );
      emitAppend("interrupted", { runId: turnId });
      send({ aborted: true, runId: turnId });
    } else {
      const shaped: { error?: unknown; hint?: unknown } | null =
        e !== null && typeof e === "object" ? (e as { error?: unknown; hint?: unknown }) : null;
      const message = e instanceof Error
        ? e.message
        : (typeof shaped?.error === "string" ? shaped.error : String(e ?? "run failed"));
      const hint = typeof shaped?.hint === "string" ? shaped.hint : "retry the prompt with a simpler request";
      emitAppend("error", { runId: turnId, error: message });
      closeRun(host.sql, host.sid, turnId);
      send({ error: message.slice(0, 300), hint });
    }
  } finally {
    if (host.live.get(host.sid) === turnController) host.live.delete(host.sid);
  }
  });
}
