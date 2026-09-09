import { createDofsVfs, type FileStore } from "pi-cf/store/vfs-dofs";
import { ensureEntriesSchema } from "pi-cf/store/entries";
import { ensureChunksSchema } from "pi-cf/store/chunks";
import { ensureWorkspaceSchema } from "pi-cf/store/sql-util";
import { ensureCompactionSchema, runPendingCompactions } from "./compaction";
import { readAttachment, socketMessage, wrapSocket, type LiveTurn, type StreamHost } from "./stream";
import { resolveCatalogModel, type RuntimeEnv } from "./model-runtime";
import { err, UNKNOWN_SESSION_HINT, type Env, type FenceNext, type FenceRead, type ModelTriple, type RouteCtx, type RouteHandler, type WorkspaceSettings } from "./routes/_shared";
import { fileRoutes } from "./routes/files";
import { sessionRoutes } from "./routes/sessions";
import { turnRoutes } from "./routes/turns";
import { opRoutes } from "./routes/ops";

export interface ForwardRequest {
  method: string;
  url: string;
  header(name: string): string | undefined;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ForwardEnv {
  WORKSPACE_DO: DurableObjectNamespace;
}

function workspaceStub(env: ForwardEnv, workspaceId: string): DurableObjectStub {
  return env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
}

export async function forwardToWorkspace(env: ForwardEnv, workspaceId: string, path: string, req: ForwardRequest, query: Record<string, string | undefined> = {}): Promise<Response> {
  const inner = new URL(path, "http://do");
  inner.searchParams.set("ws", workspaceId);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) inner.searchParams.set(key, value);
  const stub = workspaceStub(env, workspaceId);
  if (req.method !== "POST" && req.method !== "PUT") return stub.fetch(inner.toString(), { method: req.method });
  const body = await req.arrayBuffer();
  const headers: Record<string, string> = {};
  const contentType = req.header("content-type");
  if (contentType !== undefined) headers["content-type"] = contentType;
  return stub.fetch(inner.toString(), { method: req.method, headers, body });
}

export function createWorkspace(env: ForwardEnv): Promise<Response> {
  const workspaceId = crypto.randomUUID();
  return workspaceStub(env, workspaceId).fetch("http://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
}

export function forwardStream(env: ForwardEnv, workspaceId: string, sessionId: string, req: { url: string; raw: Request }): Promise<Response> {
  const inner = new URL("http://do/stream");
  inner.searchParams.set("ws", workspaceId);
  inner.searchParams.set("sid", sessionId);
  const raw = new URL(req.url);
  for (const key of ["fence", "expected"]) {
    const value = raw.searchParams.get(key);
    if (value !== null) inner.searchParams.set(key, value);
  }
  return workspaceStub(env, workspaceId).fetch(new Request(inner.toString(), { method: "GET", headers: req.raw.headers }));
}

const ROUTES: Record<string, RouteHandler> = {
  ...fileRoutes,
  ...sessionRoutes,
  ...turnRoutes,
  ...opRoutes,
};

export class WorkspaceDO implements DurableObject {
  private state: DurableObjectState;
  private files: FileStore;
  private env: Env;
  private live = new Map<string, LiveTurn>();
  private sessionQueues = new Map<string, Promise<void>>();

  private enqueueSessionTurn<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionQueues.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => cur);
    this.sessionQueues.set(sid, tail);
    return prev.catch(() => {}).then(fn).finally(() => {
      release();
      if (this.sessionQueues.get(sid) === tail) this.sessionQueues.delete(sid);
    });
  }

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.files = createDofsVfs(state.storage.sql);
  }

  private ensureSchema(): void {
    const sql = this.state.storage.sql;
    ensureWorkspaceSchema(sql);
    this.files.ensureSchema();
    ensureEntriesSchema(sql);
    ensureChunksSchema(sql);
    ensureCompactionSchema(sql);
    sql.exec("DROP TABLE IF EXISTS pi_owners");
  }

  private readFence(sid: string): FenceRead | null {
    const rows = [
      ...this.state.storage.sql.exec("SELECT ownerFence, revision FROM sessions WHERE sid = ?", sid),
    ] as Array<{ ownerFence?: unknown; revision?: unknown }>;
    if (rows.length === 0) return null;
    const raw = rows[0] as { ownerFence?: unknown; revision?: unknown };
    const fence = typeof raw.ownerFence === "string" ? raw.ownerFence : null;
    const revision = typeof raw.revision === "number" ? raw.revision : 0;
    return { fence, revision };
  }

  private rotateFence(sid: string, next: FenceNext): void {
    this.state.storage.sql.exec("UPDATE sessions SET ownerFence = ?, revision = ? WHERE sid = ?", next.fence, next.revision, sid);
  }

  private casRotateFence(
    sid: string,
    oldFence: string,
    oldRevision: number,
    next: FenceNext,
  ): boolean {
    const cur = this.readFence(sid);
    if (cur === null || cur.fence !== oldFence || cur.revision !== oldRevision) return false;
    this.rotateFence(sid, next);
    return true;
  }

  private sessionExists(ws: string, sid: string): boolean {
    const rows = [
      ...this.state.storage.sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws),
    ];
    return rows.length > 0;
  }

  private workspaceExists(ws: string): boolean {
    const rows = [
      ...this.state.storage.sql.exec(
        "SELECT 1 FROM workspaces WHERE id = ? LIMIT 1",
        ws,
      ),
    ];
    return rows.length > 0;
  }

  private requireSession(ws: string, sid: string | null, missingHint: string, unknownWsHint: string): Response | null {
    if (!ws) {
      return err("missing workspace", missingHint, 400);
    }
    if (!this.workspaceExists(ws)) {
      return err("unknown workspace", unknownWsHint, 404);
    }
    if (sid !== null && (sid.length === 0 || !this.sessionExists(ws, sid))) {
      return err("unknown session", UNKNOWN_SESSION_HINT, 404);
    }
    return null;
  }

  private readTriple(sid: string): ModelTriple | null {
    const rows = [
      ...this.state.storage.sql.exec("SELECT modelProvider, modelId, thinkingLevel, cacheRetention FROM sessions WHERE sid = ?", sid),
    ] as Array<{ modelProvider?: unknown; modelId?: unknown; thinkingLevel?: unknown; cacheRetention?: unknown }>;
    if (rows.length === 0) return null;
    const raw = rows[0];
    return {
      provider: typeof raw.modelProvider === "string" ? raw.modelProvider : null,
      id: typeof raw.modelId === "string" ? raw.modelId : null,
      thinking: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : null,
      retention: raw.cacheRetention === "long" ? "long" : "short",
    };
  }

  private sessionContextWindow(triple: { provider: string | null; id: string | null } | null): number | null {
    try {
      if (triple?.provider && triple?.id) {
        const window = resolveCatalogModel(triple.provider, triple.id).contextWindow;
        if (typeof window === "number" && window > 0) return window;
      }
    } catch {
      return null;
    }
    return null;
  }

  private readSettings(ws: string): WorkspaceSettings {
    const rows = [
      ...this.state.storage.sql.exec("SELECT modelProvider, modelId, thinkingLevel FROM workspace_settings WHERE ws = ?", ws),
    ] as Array<{ modelProvider?: unknown; modelId?: unknown; thinkingLevel?: unknown }>;
    if (rows.length === 0) return { provider: null, id: null, thinking: null };
    const raw = rows[0];
    return {
      provider: typeof raw.modelProvider === "string" ? raw.modelProvider : null,
      id: typeof raw.modelId === "string" ? raw.modelId : null,
      thinking: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : null,
    };
  }

  private routeCtx(): RouteCtx {
    return {
      state: this.state,
      env: this.env,
      files: this.files,
      requireSession: (ws, sid, missingHint, unknownWsHint) => this.requireSession(ws, sid, missingHint, unknownWsHint),
      workspaceExists: (ws) => this.workspaceExists(ws),
      sessionExists: (ws, sid) => this.sessionExists(ws, sid),
      readFence: (sid) => this.readFence(sid),
      rotateFence: (sid, next) => this.rotateFence(sid, next),
      readTriple: (sid) => this.readTriple(sid),
      readSettings: (ws) => this.readSettings(ws),
      sessionContextWindow: (triple) => this.sessionContextWindow(triple),
      streamHost: (ws, sid) => this.streamHost(ws, sid),
      enqueueSessionTurn: (sid, fn) => this.enqueueSessionTurn(sid, fn),
    };
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (handler !== undefined) {
      const res = await handler(this.routeCtx(), request, url);
      if (res !== null) return res;
    }
    return err("not found", "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files", 404);
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    runPendingCompactions(this.state.storage.sql, () => {
      void this.state.storage.setAlarm(Date.now() + 2000);
    });
  }

  private streamHost(ws: string, sid: string): StreamHost {
    const triple = this.readTriple(sid);
    return {
      sql: this.state.storage.sql,
      ws,
      sid,
      files: this.files,
      shell: this.env.SHELL_WORKER,
      runtimeEnv: this.env as unknown as RuntimeEnv,
      thinking: triple?.thinking ?? null,
      retention: triple?.retention ?? "short",
      model: triple?.provider != null && triple?.id != null ? { provider: triple.provider, id: triple.id } : null,
      workspaceKnown: ws !== "" && this.workspaceExists(ws),
      sessionKnown: ws !== "" && sid !== "" && this.sessionExists(ws, sid),
      readFence: () => this.readFence(sid),
      casRotateFence: (oldFence, oldRevision, next) => this.casRotateFence(sid, oldFence, oldRevision, next),
      live: this.live,
      sockets: () => this.state.getWebSockets(),
      enqueue: (fn) => this.enqueueSessionTurn(sid, fn),
      scheduleAlarm: () => this.state.storage.setAlarm(Date.now() + 2000),
    };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = readAttachment(ws);
    if (att === null) {
      const sock = wrapSocket(ws);
      sock.send({ error: "bad handshake", hint: "reconnect the stream; the socket carried no session" });
      sock.close(4403, "socket carried no session");
      return;
    }
    const sock = wrapSocket(ws);
    try {
      await socketMessage(this.streamHost(att.ws, att.sid), sock, message);
    } catch (e) {
      sock.send({
        error: e instanceof Error ? e.message.slice(0, 300) : "unexpected stream failure",
        hint: "retry the frame; if the turn is stuck, send {abort} and reconnect",
      });
    }
  }
}
