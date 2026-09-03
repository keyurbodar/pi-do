// stream.ts — WS upgrade for GET /workspaces/:id/sessions/:sid/stream.
// Live turns over a socket: {prompt, fence, expected} in, {entry} frames out.
// Every entry frame is re-read from storage by cursor before emit; the socket
// is a view, pi_entries is the truth. Unknown sessions and failed fences get
// an {error, hint} frame followed by a close frame — never a bare drop.
import { appendEntry, closeRun, getEntry, openRun, type EntriesSql } from "./entries";
import { enforceFence } from "./fence";
import type { FileStore } from "./files";
import { buildRuntime, type RuntimeEnv } from "./model-runtime";
import { createAgentSession } from "../../packages/pi-cf/src/session";

export interface StreamShell {
  exec(input: {
    command: string;
    cwd?: string;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean }>;
}

export interface StreamDeps {
  sql: EntriesSql;
  ws: string;
  sid: string;
  files: FileStore;
  shell: StreamShell;
  runtimeEnv: RuntimeEnv;
  workspaceKnown: boolean;
  sessionKnown: boolean;
  readFence(): { fence: string | null; revision: number } | null;
  rotateFence(next: { fence: string; revision: number }): void;
}

const HEARTBEAT_MS = 15000;
const CLOSE_UNKNOWN = 4404;
const CLOSE_FENCED = 4403;
const CLOSE_CONFLICT = 4409;

function shortReason(hint: string): string {
  return hint.length > 120 ? hint.slice(0, 120) : hint;
}

export function handleStream(request: Request, deps: StreamDeps): Response {
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
  server.accept();

  let busy = false;
  let runId: string | null = null;
  let controller: AbortController | null = null;
  let closed = false;

  const send = (frame: unknown): void => {
    if (closed) return;
    try {
      server.send(JSON.stringify(frame));
    } catch {
      closed = true;
    }
  };
  const closeSocket = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      server.close(code, shortReason(reason));
    } catch {
      // Socket already gone; the error frame above carries the hint.
    }
  };
  // Append first, then re-read the row and emit that copy.
  const emitAppend = (type: string, body: unknown): void => {
    const cursor = appendEntry(deps.sql, deps.sid, type, body);
    const row = getEntry(deps.sql, deps.sid, cursor);
    if (row !== null) send({ entry: row });
  };
  const heartbeat = setInterval(() => {
    send({ ping: true });
  }, HEARTBEAT_MS);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    // Socket dropped mid-turn: abort into the harness so the run row ends
    // interrupted instead of orphaned open; the catch below persists it.
    controller?.abort();
  };
  server.addEventListener("close", cleanup);
  server.addEventListener("error", cleanup);

  if (!deps.workspaceKnown) {
    const hint = "create one with POST /workspaces first, then mint a session";
    send({ error: "unknown workspace", hint });
    closeSocket(CLOSE_UNKNOWN, hint);
    return new Response(null, { status: 101, webSocket: client });
  }
  if (!deps.sessionKnown) {
    const hint = "mint one with POST /workspaces/:id/sessions first, then retry with that session id";
    send({ error: "unknown session", hint });
    closeSocket(CLOSE_UNKNOWN, hint);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Stale-fence connect: ?fence=&expected= checked at upgrade, close on failure.
  try {
    const query = new URL(request.url).searchParams;
    if (query.has("fence") || query.has("expected")) {
      const fence = query.get("fence");
      const expected = Number(query.get("expected"));
      if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
        const hint = "retry the stream with both ?fence=F&expected=N from the live session row";
        send({ error: "missing fence", hint });
        closeSocket(CLOSE_FENCED, hint);
        return new Response(null, { status: 101, webSocket: client });
      }
      const checked = enforceFence(deps.readFence(), fence, expected);
      if ("status" in checked) {
        send(checked.body);
        closeSocket(checked.status === 403 ? CLOSE_FENCED : CLOSE_CONFLICT, checked.body.hint);
        return new Response(null, { status: 101, webSocket: client });
      }
    }
  } catch {
    const hint = "could not read the stream handshake; reconnect and retry";
    send({ error: "bad handshake", hint });
    closeSocket(CLOSE_FENCED, hint);
    return new Response(null, { status: 101, webSocket: client });
  }

  async function startTurn(prompt: string, fence: unknown, expected: unknown, hasFence: boolean): Promise<void> {
    if (busy) {
      send({
        busy: true,
        hint: "a turn is already running on this socket; wait for {done} or {aborted} before sending the next prompt",
      });
      return;
    }
    busy = true;
    const cur = deps.readFence();
    let creds: { fence: string; revision: number } | null = null;
    if (hasFence) {
      const checked = enforceFence(cur, fence, expected);
      if ("status" in checked) {
        busy = false;
        send(checked.body);
        closeSocket(checked.status === 403 ? CLOSE_FENCED : CLOSE_CONFLICT, checked.body.hint);
        return;
      }
      deps.rotateFence(checked);
      creds = checked;
    }
    const turnId = crypto.randomUUID();
    runId = turnId;
    const turnController = new AbortController();
    controller = turnController;
    try {
      openRun(deps.sql, deps.sid, turnId);
      if (creds !== null) send({ started: true, runId: turnId, fence: creds.fence, revision: creds.revision });
      emitAppend("prompt", { runId: turnId, prompt });
      const runtime = buildRuntime(deps.runtimeEnv);
      const session = createAgentSession({
        files: deps.files,
        ws: deps.ws,
        shell: deps.shell,
        model: runtime.model,
      });
      const turn = await session.run(prompt, {
        signal: turnController.signal,
        onUpdate: (event) => {
          if (event.kind === "toolCall") {
            emitAppend("toolCall", { runId: turnId, id: event.id, tool: event.tool, args: event.args });
          } else {
            emitAppend("toolResult", { runId: turnId, id: event.id, tool: event.tool, output: event.output });
          }
        },
      });
      emitAppend("result", { runId: turnId, result: turn.result });
      closeRun(deps.sql, deps.sid, turnId);
      if (creds !== null) send({ done: true, fence: creds.fence, revision: creds.revision, result: turn.result });
      else send({ done: true, result: turn.result });
    } catch (e) {
      if (turnController.signal.aborted) {
        deps.sql.exec(
          "UPDATE runs SET status = ? WHERE sid = ? AND runId = ?",
          "interrupted",
          deps.sid,
          turnId,
        );
        emitAppend("interrupted", { runId: turnId });
        send({ aborted: true, runId: turnId });
      } else {
        const message = e instanceof Error ? e.message : String(e ?? "run failed");
        emitAppend("error", { runId: turnId, error: message });
        closeRun(deps.sql, deps.sid, turnId);
        send({ error: message.slice(0, 300), hint: "retry the prompt with a simpler request" });
      }
    } finally {
      busy = false;
      runId = null;
      controller = null;
    }
  }

  server.addEventListener("message", (event: MessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      const text = typeof event.data === "string" ? event.data : String(event.data ?? "");
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad frame");
      msg = parsed as Record<string, unknown>;
    } catch {
      send({ error: "bad frame", hint: "send JSON like {prompt, fence, expected}, {abort}, or {steer, text}" });
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
      if (controller !== null) controller.abort();
      else {
        send({ error: "no turn in flight", hint: "send {prompt} first; abort only cancels a running turn" });
      }
      return;
    }
    if (steerOn) {
      const text = msg["text"];
      if (typeof text !== "string" || text.length === 0) {
        send({ error: "missing steer text", hint: "retry as {steer, text} with a non-empty string" });
        return;
      }
      if (runId === null) {
        send({ error: "no turn in flight", hint: "send {prompt} first; steer only appends mid-turn" });
        return;
      }
      emitAppend("steer", { runId, text });
    }
    if (promptValue !== undefined) {
      if (promptValue.length === 0) {
        send({ error: "missing prompt", hint: 'retry with a non-empty prompt, e.g. {"prompt": "read seed.txt"}' });
        return;
      }
      const hasFence = "fence" in msg || "expected" in msg;
      void startTurn(promptValue, msg["fence"], msg["expected"], hasFence);
      return;
    }
    send({ error: "unknown frame", hint: "send {prompt, fence, expected}, {abort}, or {steer, text}" });
  });

  return new Response(null, { status: 101, webSocket: client });
}
