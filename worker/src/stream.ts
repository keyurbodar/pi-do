// stream.ts — hibernation WS handlers for GET /workspaces/:id/sessions/:sid/stream.
// Live turns over a socket: {prompt, fence, expected} in, {entry} frames out.
// Extension frames ride the same socket: {get_commands} lists the session's
// extension commands, {extension_ui_request} raises an extension question and
// {extension_ui_response} answers one. UI entries persist before emit and
// optional {fence, expected} enforces exactly like a prompt.
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
import { appendEntry, closeRun, getEntry, listEntries, openRun, sessionLeaf, type EntriesSql } from "../../packages/pi-cf/src/entries";
import { loadInlineExtensions, type InlineExtensionFactory } from "../../packages/pi-cf/src/extensions";
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
  extensions: InlineExtensionFactory[];
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
    sock.send({ error: "bad frame", hint: "send JSON like {prompt, fence, expected}, {abort}, {steer, text}, {get_commands}, or {extension_ui_request/response}" });
    return;
  }
  const wantCommands = msg["get_commands"] === true || msg["type"] === "get_commands";
  const wantUiAsk = msg["extension_ui_request"] === true || msg["type"] === "extension_ui_request";
  const wantUiAnswer = msg["extension_ui_response"] === true || msg["type"] === "extension_ui_response";
  const isAbort = msg["abort"] === true || msg["type"] === "abort";
  const steerOn = msg["steer"] === true || msg["type"] === "steer";
  const promptValue = typeof msg["prompt"] === "string"
    ? (msg["prompt"] as string)
    : msg["type"] === "prompt" && typeof msg["text"] === "string"
      ? (msg["text"] as string)
      : undefined;
  if (wantCommands) {
    await sendCommands(host, sock);
    return;
  }
  if (wantUiAsk) {
    uiAsk(host, sock, msg);
    return;
  }
  if (wantUiAnswer) {
    uiAnswer(host, sock, msg);
    return;
  }

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
  sock.send({ error: "unknown frame", hint: "send {prompt, fence, expected}, {abort}, {steer, text}, {get_commands}, or {extension_ui_request/response}" });
}

// Extension command listing for get_commands, sourced from the session's own
// extensions (first-party passes none, so the list is empty until PR21a's VFS
// loader provides workspace commands). Never a sample registry: the list
// must match what turns on this session can actually invoke.
async function sendCommands(host: StreamHost, sock: StreamSocket): Promise<void> {
  const ext = await loadInlineExtensions(host.extensions);
  const commands = [...ext.commands.values()].map((c) => ({ name: c.name, description: c.description ?? "" }));
  sock.send({ commands });
}

// Optional {fence, expected} on UI frames enforces exactly like a prompt:
// absent means unchecked, present means both required and checked, and a
// failed check sends the fence body and closes the stale socket.
function checkUiFence(host: StreamHost, sock: StreamSocket, msg: Record<string, unknown>): boolean {
  if (!("fence" in msg || "expected" in msg)) return true;
  const fence = msg["fence"];
  const expected = msg["expected"];
  if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected) || typeof expected !== "number") {
    sock.send({ error: "missing fence", hint: "retry the frame with both {fence, expected}, or omit both" });
    return false;
  }
  const checked = enforceFence(host.readFence(), fence, expected);
  if ("status" in checked) {
    sock.send(checked.body);
    sock.close(checked.status === 403 ? CLOSE_FENCED : CLOSE_CONFLICT, checked.body.hint);
    return false;
  }
  return true;
}

// True when an extension_ui_request entry with this id has no later
// extension_ui_response entry with the same id. Pending-ness is read from
// storage on every answer, so an eviction eats no correctness state.
function hasPendingUiRequest(sql: EntriesSql, sid: string, id: string): boolean {
  const pending = new Set<string>();
  let after = 0;
  for (;;) {
    const page = listEntries(sql, sid, after, 1000);
    if (page.length === 0) break;
    for (const entry of page) {
      after = entry.cursor;
      let body: unknown;
      try {
        body = JSON.parse(entry.body);
      } catch {
        continue;
      }
      if (body === null || typeof body !== "object" || !("id" in body)) continue;
      const got = (body as Record<string, unknown>)["id"];
      if (typeof got !== "string") continue;
      if (entry.type === "extension_ui_request") pending.add(got);
      else if (entry.type === "extension_ui_response") pending.delete(got);
    }
    if (page.length < 1000) break;
  }
  return pending.has(id);
}

// An extension tool asks: persist the question before emitting, then send
// the render frame the client answers. The id is client-chosen (or assigned)
// so scripted drivers round-trip without a turn in flight.
function uiAsk(host: StreamHost, sock: StreamSocket, msg: Record<string, unknown>): void {
  const question = msg["question"];
  if (typeof question !== "string" || question.length === 0) {
    sock.send({ error: "missing ui question", hint: "retry as {extension_ui_request: true, question, id?} with a non-empty question" });
    return;
  }
  let id = msg["id"];
  if (id === undefined) id = crypto.randomUUID();
  if (typeof id !== "string" || id.length === 0) {
    sock.send({ error: "bad ui id", hint: "retry with a non-empty string id, or omit id for an assigned one" });
    return;
  }
  if (!checkUiFence(host, sock, msg)) return;
  const cursor = appendEntry(host.sql, host.sid, "extension_ui_request", { id, question });
  const row = getEntry(host.sql, host.sid, cursor);
  if (row !== null) sock.send({ entry: row });
  sock.send({ extension_ui_request: true, id, question });
}

// The client answers: match against a pending request, persist the answer
// before emitting, then ack so the turn can resume. Unknown ids get a hint,
// never a silent drop.
function uiAnswer(host: StreamHost, sock: StreamSocket, msg: Record<string, unknown>): void {
  const id = msg["id"];
  if (typeof id !== "string" || id.length === 0) {
    sock.send({ error: "missing ui id", hint: "retry as {extension_ui_response: true, id, response} with the pending request id" });
    return;
  }
  const response = msg["response"];
  if (typeof response !== "string") {
    sock.send({ error: "missing ui response", hint: "retry with a string response answering the pending request" });
    return;
  }
  if (!checkUiFence(host, sock, msg)) return;
  if (!hasPendingUiRequest(host.sql, host.sid, id)) {
    sock.send({ error: "unknown ui request", hint: "answer a pending extension_ui_request id; answered or unknown ids cannot resume" });
    return;
  }
  const cursor = appendEntry(host.sql, host.sid, "extension_ui_response", { id, response });
  const row = getEntry(host.sql, host.sid, cursor);
  if (row !== null) sock.send({ entry: row });
  sock.send({ answered: true, id });
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
      // First-party host: no inline extensions (PR19 keeps behavior unchanged).
      extensions: [],
      apiKey: stub ? undefined : resolveProviderKey(host.runtimeEnv, respProvider),
      history: { leaf: historyLeaf, readEntry: (cursor) => getEntry(host.sql, host.sid, cursor) },
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
