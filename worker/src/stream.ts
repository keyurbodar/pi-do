import { appendEntry, closeRun, getEntry, openRun, sessionLeaf, type EntriesSql } from "pi-cf/store/entries";
import { enforceFence } from "pi-cf/store/fence";
import type { FileStore } from "pi-cf/store/vfs-dofs";
import { clampThinkingLevel, defaultTurnModel, keyedProviders, resolveCatalogModel, resolveKeyedModel, resolveProviderKey, type RuntimeEnv, type RuntimeModel } from "./model-runtime";
import { createAgentSession, type SessionTurn } from "pi-cf/agent/session";
import { compactionPending, maybeMarkForCompaction } from "./compaction";

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
  retention: "short" | "long";
  model: { provider: string; id: string } | null;
  workspaceKnown: boolean;
  sessionKnown: boolean;
  readFence(): { fence: string | null; revision: number } | null;
  casRotateFence(oldFence: string, oldRevision: number, next: { fence: string; revision: number }): boolean;
  live: Map<string, AbortController>;
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  scheduleAlarm(): Promise<void>;
}

export interface StreamAttachment {
  ws: string;
  sid: string;
}

export interface StreamSocket {
  send(frame: unknown): void;
  close(code: number, reason: string): void;
}

export type CheckedFence =
  | { status: number; body: { error: string; hint: string; revision?: number } }
  | { fence: string; revision: number }
  | null;

export interface TurnModel {
  model: { id: string; name?: string; api?: string; provider?: string; baseUrl?: string };
  provider: string;
  stub: boolean;
  like: RuntimeModel | Record<string, never>;
}

export function checkedRotate(
  current: { fence: string | null; revision: number } | null,
  body: unknown,
  missingHint: string,
  write: ((next: { fence: string; revision: number }) => void) | null,
): CheckedFence {
  const rec = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (rec === null || (!("fence" in rec) && !("expected" in rec))) return null;
  const fence = rec["fence"];
  const expected = rec["expected"];
  if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
    return { status: 400, body: { error: "missing fence", hint: missingHint } };
  }
  const checked = enforceFence(current, fence, expected);
  if ("status" in checked) return { status: checked.status, body: checked.body };
  if (write !== null) write(checked);
  return checked;
}

export function resolveTurnModel(env: RuntimeEnv, catalog: RuntimeModel | null): TurnModel {
  if (catalog === null) {
    const d = defaultTurnModel();
    return { model: d, provider: d.provider, stub: true, like: {} };
  }
  const keyed = keyedProviders(env);
  if (keyed.length === 0) return { model: { id: catalog.id }, provider: catalog.provider, stub: true, like: catalog };
  const m = resolveKeyedModel(env, catalog.provider, catalog.id);
  return { model: m, provider: m.provider, stub: false, like: catalog };
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
      }
    },
    close(code: number, reason: string): void {
      try {
        ws.close(code, shortReason(reason));
      } catch {
      }
    },
  };
}

function emitEntry(host: StreamHost, sock: StreamSocket, type: string, body: unknown): void {
  const cursor = appendEntry(host.sql, host.sid, type, body);
  const row = getEntry(host.sql, host.sid, cursor);
  if (row !== null) sock.send({ entry: row });
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
      const fenceBody: Record<string, unknown> = {};
      if (query.has("fence")) fenceBody["fence"] = query.get("fence");
      if (query.has("expected")) fenceBody["expected"] = Number(query.get("expected"));
      const rot = checkedRotate(host.readFence(), fenceBody, "retry the stream with both ?fence=F&expected=N from the live session row", null);
      if (rot !== null && "status" in rot) {
        sock.send(rot.body);
        sock.close(rot.status === 409 ? CLOSE_CONFLICT : CLOSE_FENCED, rot.body.hint);
        return new Response(null, { status: 101, webSocket: client });
      }
    }
  } catch {
    const hint = "could not read the stream handshake; reconnect and retry";
    sock.send({ error: "bad handshake", hint });
    sock.close(CLOSE_FENCED, hint);
    return new Response(null, { status: 101, webSocket: client });
  }
  if (host.live.get(host.sid) === undefined) {
    for (let n = 0; n < 32; n++) {
      const orphan = openRunId(host.sql, host.sid);
      if (orphan === null) break;
      host.sql.exec("UPDATE runs SET status = ? WHERE sid = ? AND runId = ?", "interrupted", host.sid, orphan);
      emitEntry(host, sock, "interrupted", { runId: orphan });
    }
  }

  return new Response(null, { status: 101, webSocket: client });
}

export function socketClosed(host: StreamHost): void {
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
    emitEntry(host, sock, "steer", { runId, text });
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

export interface TurnInput {
  prompt: string;
  catalog: RuntimeModel | null;
  thinking: string | null;
  runId: string;
  signal?: AbortSignal;
}

export interface TurnSink {
  push(type: string, body: unknown): void;
  done(runId: string, turn: SessionTurn, runtime: { via: string; model: string; provider: string; thinking: string | null }): void;
  fail(runId: string, error: string, hint: string, status: number, opened: boolean): void;
  aborted(runId: string): void;
}

function shaped(e: unknown, fallbackError: string, fallbackHint: string): { error: string; hint: string } {
  const rec = e !== null && typeof e === "object" ? (e as { error?: unknown; hint?: unknown }) : null;
  const error = typeof rec?.error === "string" ? rec.error : (e instanceof Error ? e.message : fallbackError);
  return { error: error.slice(0, 300), hint: typeof rec?.hint === "string" ? rec.hint : fallbackHint };
}

export async function executeTurn(host: StreamHost, input: TurnInput, sink: TurnSink): Promise<void> {
  let resolved: TurnModel;
  try {
    resolved = resolveTurnModel(host.runtimeEnv, input.catalog);
  } catch (e) {
    const out = shaped(e, "unknown model", "retry with a catalog model");
    sink.fail(input.runId, out.error, out.hint, 404, false);
    return;
  }
  const session = createAgentSession({
    files: host.files,
    ws: host.ws,
    shell: host.shell,
    model: resolved.model,
    apiKey: resolved.stub ? undefined : resolveProviderKey(host.runtimeEnv, resolved.provider),
    history: { leaf: sessionLeaf(host.sql, host.sid), readEntry: (cursor) => getEntry(host.sql, host.sid, cursor) },
    sessionId: host.sid,
    cacheRetention: host.retention,
  });
  try {
    const turn = await session.run(input.prompt, {
      signal: input.signal,
      thinking: input.thinking,
      onUpdate: (event) => {
        if (event.kind === "toolCall") sink.push("toolCall", { runId: input.runId, id: event.id, tool: event.tool, args: event.args });
        else if (event.kind === "toolResult") sink.push("toolResult", { runId: input.runId, id: event.id, tool: event.tool, output: event.output });
        else if (event.kind === "text") sink.push("text", { runId: input.runId, delta: event.delta });
        else sink.push("thinking", { runId: input.runId, delta: event.delta });
      },
    });
    sink.done(input.runId, turn, { via: turn.via, model: turn.model, provider: resolved.provider, thinking: input.thinking });
    if (maybeMarkForCompaction(host.sql, host.sid)) await host.scheduleAlarm();
    else if (compactionPending(host.sql, host.sid)) await host.scheduleAlarm();
  } catch (e) {
    if (input.signal?.aborted) {
      sink.aborted(input.runId);
      return;
    }
    const out = shaped(e, "run failed", "retry the prompt with a simpler request");
    sink.fail(input.runId, out.error, out.hint, 500, true);
  }
}

async function startTurn(
  host: StreamHost,
  sock: StreamSocket,
  prompt: string,
  fence: unknown,
  expected: unknown,
  hasFence: boolean,
): Promise<void> {
  await host.enqueue(async () => {
    const rot = checkedRotate(host.readFence(), hasFence ? { fence, expected } : undefined, "retry the turn with both {fence, expected}, or omit both", null);
    if (rot !== null && "status" in rot) {
      if (rot.status === 400) {
        sock.send(rot.body);
        return;
      }
      sock.send(rot.body);
      sock.close(rot.status === 403 ? CLOSE_FENCED : CLOSE_CONFLICT, rot.body.hint);
      return;
    }
    const held: { fence: string; revision: number } | null = rot === null
      ? null
      : { fence: fence as string, revision: expected as number };
    const runId = crypto.randomUUID();
    const turnController = new AbortController();
    host.live.set(host.sid, turnController);
    const emit = (type: string, body: unknown): void => emitEntry(host, sock, type, body);
    const sink: TurnSink = {
      push: emit,
      done: (doneId, turn, runtime) => {
        emit("result", turn.halt ? { runId: doneId, result: turn.result, usage: turn.usage, halt: turn.halt } : { runId: doneId, result: turn.result, usage: turn.usage });
        closeRun(host.sql, host.sid, doneId);
        if (held !== null) {
          const next = { fence: crypto.randomUUID(), revision: held.revision + 1 };
          if (!host.casRotateFence(held.fence, held.revision, next)) {
            const cur = host.readFence();
            sock.send({ error: "revision conflict", hint: "a concurrent holder rotated mid-turn; re-claim and retry", revision: cur?.revision ?? 0 });
            sock.close(CLOSE_CONFLICT, "concurrent rotation mid-turn");
            return;
          }
          sock.send({ done: true, fence: next.fence, revision: next.revision, result: turn.result, runtime, usage: turn.usage, ...(turn.halt ? { halt: turn.halt } : {}) });
        } else sock.send({ done: true, result: turn.result, runtime, usage: turn.usage, ...(turn.halt ? { halt: turn.halt } : {}) });
      },
      fail: (failId, error, hint) => {
        emit("error", { runId: failId, error });
        closeRun(host.sql, host.sid, failId);
        sock.send({ error, hint });
      },
      aborted: (abortId) => {
        host.sql.exec("UPDATE runs SET status = ? WHERE sid = ? AND runId = ?", "interrupted", host.sid, abortId);
        emit("interrupted", { runId: abortId });
        sock.send({ aborted: true, runId: abortId });
      },
    };
    try {
      openRun(host.sql, host.sid, runId);
      emit("prompt", { runId, prompt });
      let catalog: RuntimeModel | null;
      try {
        catalog = host.model === null ? null : resolveCatalogModel(host.model.provider, host.model.id);
      } catch (e) {
        const out = shaped(e, "run failed", "retry the prompt with a simpler request");
        sink.fail(runId, out.error, out.hint, 404, true);
        return;
      }
      const effThinking = host.thinking === null ? null : clampThinkingLevel(catalog ?? {}, host.thinking);
      await executeTurn(host, { prompt, catalog, thinking: effThinking, runId, signal: turnController.signal }, sink);
    } finally {
      if (host.live.get(host.sid) === turnController) host.live.delete(host.sid);
    }
  });
}
