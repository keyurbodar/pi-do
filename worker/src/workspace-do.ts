import * as v from "valibot";
import { createDofsVfs, type FileStore } from "../../packages/pi-cf/src/vfs-dofs";
import { appendEntry, ensureEntriesSchema, entryHead, listEntries, openRun, recordTurnWithOpen, runInSyncTx, sumResultUsage, type SessionUsageMeta } from "../../packages/pi-cf/src/entries";
import { ensureWorkspaceSchema } from "../../packages/pi-cf/src/sql-util";
import type { SessionUsage } from "../../packages/pi-cf/src/session";
import { archiveMeta, compactionPending, ensureCompactionSchema, pendingSessions, readArchivePage, runCompaction } from "./compaction";
import { acceptStream, checkedRotate, executeTurn, readAttachment, socketClosed, socketMessage, wrapSocket, type StreamHost, type TurnSink } from "./stream";
import { normalizeWorkspacePath } from "../../packages/pi-cf/src/tools";
import { buildRuntime, clampThinkingLevel, keyedProviders, listCatalogModels, resolveCatalogModel, resolveKeyedModelLive, supportedThinkingLevels, THINKING_LEVELS, type RuntimeEnv, type RuntimeModel } from "./model-runtime";
import { createWorkspaceFs, gateArgv, hasGitDir, notARepoBody, NotARepoError, runGitRead, runGitWrite, WRITE_SUBCOMMANDS } from "./git";
import { bgSchema, execSchema, handleSchema, hintFor, sidSchema, type ValidatorRoute } from "./schemas";
import { EXEC_TIMEOUT_MS } from "./shell-exec";

interface ShellWorkerBinding {
  exec(input: {
    command: string;
    cwd?: string;
    env?: unknown;
    sid?: string;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean; killed: boolean }>;
  kill(input: { sid: string }): Promise<{ killed: boolean }>;
  dispose(input: { sid: string }): Promise<{ disposed: true; stdoutBytes: number; stderrBytes: number }>;
  bgStart(input: { command: string; cwd?: string; env?: unknown }): Promise<{ handle: string }>;
  bgRead(input: { handle: string }): Promise<{ done: boolean; stdout?: string; stderr?: string; exit?: number; timedOut?: boolean; killed?: boolean }>;
  bgKill(input: { handle: string }): Promise<{ killed: boolean }>;
}

interface Env {
  WORKSPACE_DO: DurableObjectNamespace;
  SHELL_WORKER: ShellWorkerBinding;
}

const MINT_WS_HINT = "create one with POST /workspaces first, then mint a session";
const UNKNOWN_SESSION_HINT = "mint one with POST /workspaces/:id/sessions first, then retry with that session id";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_TOO_LARGE_HINT = "retry with a file under 8 MiB, or split it across paths";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(error: string, hint: string, status: number): Response {
  return json({ error, hint }, status);
}
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

const JSON_CT = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

function issueKey(issues: unknown): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const first = issues[0];
  if (first === null || typeof first !== "object" || !("path" in first)) return null;
  const path = first.path;
  if (!Array.isArray(path)) return null;
  for (const segment of path) {
    if (segment !== null && typeof segment === "object" && "key" in segment && typeof segment.key === "string") return segment.key;
  }
  return null;
}

type Validated<T> = { ok: true; value: T } | { ok: false; response: Response };

async function readValidated<T extends v.GenericSchema | v.GenericSchemaAsync>(request: Request, route: ValidatorRoute, schema: T): Promise<Validated<v.InferOutput<T>>> {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !JSON_CT.test(contentType)) {
    const spec = hintFor[route].default;
    return { ok: false, response: err(spec.error, spec.hint, 400) };
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, response: new Response("Malformed JSON in request body", { status: 400 }) };
  }
  const parsed = await v.safeParseAsync(schema, value);
  if (!parsed.success) {
    const table = hintFor[route];
    const key = issueKey(parsed.issues);
    const spec = (key !== null ? table[key] : undefined) ?? table.default;
    return { ok: false, response: err(spec.error, spec.hint, 400) };
  }
  return { ok: true, value: parsed.output };
}

type UsageRow = { inTokens: number; outTokens: number; cacheRead: number; costTotal: number; elapsedMs: number; tokensPerSec: number | null };

const zeroUsage: UsageRow = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null };

function tokensPerSec(outTokens: number, elapsedMs: number): number | null {
  return outTokens > 0 && elapsedMs >= 100 ? (outTokens * 1000) / elapsedMs : null;
}

function fmtUsage(sums: SessionUsage, contextWindow: number | null): SessionUsageMeta {
  const full: SessionUsage = { ...zeroUsage, ...sums };
  const context = full.inTokens + full.outTokens + full.cacheRead;
  const contextPct = typeof contextWindow === "number" && contextWindow > 0 ? (context / contextWindow) * 100 : null;
  const hitDenom = full.inTokens + full.cacheRead;
  return { ...full, tokensPerSec: tokensPerSec(full.outTokens, full.elapsedMs), contextPct, hitPct: hitDenom > 0 ? (full.cacheRead / hitDenom) * 100 : 0 };
}

function fmtModel(sid: string, provider: string, id: string, rot: { fence: string; revision: number } | null, revision: number): Response {
  if (rot !== null) return json({ sessionId: sid, model: { provider, id }, fence: rot.fence, revision: rot.revision });
  return json({ sessionId: sid, model: { provider, id }, revision });
}

function fmtThinking(sid: string, applied: string, requested: string, rot: { fence: string; revision: number } | null, revision: number): Response {
  if (rot !== null) return json({ sessionId: sid, thinking: applied, requested, fence: rot.fence, revision: rot.revision });
  return json({ sessionId: sid, thinking: applied, requested, revision });
}

function fmtSettings(ws: string, settings: { provider: string | null; id: string | null; thinking: string | null }): Response {
  return json({ ws, settings: { modelProvider: settings.provider, modelId: settings.id, thinkingLevel: settings.thinking } });
}

function saveSettings(sql: { exec(query: string, ...bindings: unknown[]): unknown }, ws: string, provider: unknown, id: unknown, thinking: unknown): void {
  sql.exec("INSERT OR REPLACE INTO workspace_settings(ws, modelProvider, modelId, thinkingLevel) VALUES (?, ?, ?, ?)", ws, provider, id, thinking);
}

export class WorkspaceDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private files: FileStore;
  private live = new Map<string, AbortController>();
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
    ensureCompactionSchema(sql);
    sql.exec("DROP TABLE IF EXISTS pi_owners");
  }

  private readFence(sid: string): { fence: string | null; revision: number } | null {
    const rows = [
      ...this.state.storage.sql.exec("SELECT ownerFence, revision FROM sessions WHERE sid = ?", sid),
    ] as Array<{ ownerFence?: unknown; revision?: unknown }>;
    if (rows.length === 0) return null;
    const raw = rows[0] as { ownerFence?: unknown; revision?: unknown };
    const fence = typeof raw.ownerFence === "string" ? raw.ownerFence : null;
    const revision = typeof raw.revision === "number" ? raw.revision : 0;
    return { fence, revision };
  }

  private rotateFence(sid: string, next: { fence: string; revision: number }): void {
    this.state.storage.sql.exec("UPDATE sessions SET ownerFence = ?, revision = ? WHERE sid = ?", next.fence, next.revision, sid);
  }

  private casRotateFence(
    sid: string,
    oldFence: string,
    oldRevision: number,
    next: { fence: string; revision: number },
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

  private readTriple(sid: string): { provider: string | null; id: string | null; thinking: string | null; retention: "short" | "long" } | null {
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

  private readSettings(ws: string): { provider: string | null; id: string | null; thinking: string | null } {
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

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/create") {
      let workspaceId: string | undefined;
      try {
        const body = (await request.json()) as { workspaceId?: string };
        workspaceId = body.workspaceId;
      } catch {
        workspaceId = undefined;
      }
      if (!workspaceId) {
        return err("missing workspaceId", "POST /workspaces on the Worker to mint a workspace id", 400);
      }
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO workspaces(id, created_at) VALUES (?, ?)",
        workspaceId,
        new Date().toISOString(),
      );
      return json({ workspaceId });
    }

    if (request.method === "GET" && url.pathname === "/exists") {
      const ws = url.searchParams.get("ws") ?? "";
      const bad = this.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;
      return json({ workspaceId: ws, exists: true });
    }

    if (url.pathname === "/files") {
      const ws = url.searchParams.get("ws") ?? "";
      const bad = this.requireSession(ws, null, "call PUT /workspaces/:id/files?path=P on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;

      if (request.method === "PUT") {
        const path = url.searchParams.get("path");
        if (!path) {
          return err("missing path", "retry as PUT /workspaces/:id/files?path=P with raw bytes", 400);
        }
        const declared = request.headers.get("content-length");
        if (declared !== null && Number(declared) > MAX_FILE_BYTES) {
          return err("file too large", FILE_TOO_LARGE_HINT, 413);
        }
        const buf = new Uint8Array(await request.arrayBuffer());
        if (buf.byteLength > MAX_FILE_BYTES) {
          return err("file too large", FILE_TOO_LARGE_HINT, 413);
        }
        const bytes = this.files.put(ws, path, buf, new Date().toISOString());
        return json({ path, bytes });
      }

      if (request.method === "DELETE") {
        const rawPath = url.searchParams.get("path");
        if (!rawPath) {
          return err("missing path", "retry as DELETE /workspaces/:id/files?path=P", 400);
        }
        let path: string;
        try {
          path = normalizeWorkspacePath(rawPath);
        } catch (e) {
          if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
            const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a workspace-relative path";
            return err(e.error, hint, 400);
          }
          throw e;
        }
        if (path === "") {
          return err("bad path", "refusing to remove the workspace root; retry with a file or directory path", 400);
        }
        if (this.files.exists(ws, path)) {
          this.files.remove(ws, path);
          return json({ removed: [path] });
        }
        const under = this.files.list(ws, `${path}/`);
        if (under.length === 0) {
          return err(`no such file: ${path}`, "check the path with files ls first, then retry", 404);
        }
        if (url.searchParams.get("recursive") !== "true") {
          return err(`${path} is a directory`, "retry with ?recursive=true to delete the whole tree, or remove files one by one", 400);
        }
        const removed = this.files.removeTree(ws, `${path}/`);
        return json({ removed });
      }

      if (request.method === "GET") {
        if (url.searchParams.has("list")) {
          const dir = url.searchParams.get("list") ?? "";
          const entries = this.files.list(ws, dir);
          return json({ entries });
        }
        const path = url.searchParams.get("path");
        if (!path) {
          return err("missing path", "retry as GET /workspaces/:id/files?path=P, or list with ?list=DIR", 400);
        }
        const body = this.files.get(ws, path);
        if (body === undefined) {
          return err(`no such file: ${path}`, "upload it with PUT /workspaces/:id/files?path=P first", 404);
        }
        return new Response(body as BodyInit, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
    }

    if (request.method === "POST" && url.pathname === "/sessions") {
      const ws = url.searchParams.get("ws") ?? "";
      const bad = this.requireSession(ws, null, "call POST /workspaces/:id/sessions on the Worker instead", "create one with POST /workspaces first, then POST /workspaces/:id/sessions");
      if (bad) return bad;
      let retention: unknown;
      let hasRetention = false;
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object" && "retention" in body) {
          retention = (body as { retention?: unknown }).retention;
          hasRetention = true;
        }
      } catch {
        retention = undefined;
      }
      const effRetention = hasRetention ? retention : "short";
      if (effRetention !== "short" && effRetention !== "long") {
        return err("bad retention", 'retry with {"retention": "short"|"long"}; omit it for short', 400);
      }
      const sessionId = crypto.randomUUID();
      const fence = crypto.randomUUID();
      const defaults = this.readSettings(ws);
      this.state.storage.sql.exec(
        "INSERT INTO sessions(sid, ws, created_at, ownerFence, revision, modelProvider, modelId, thinkingLevel, cacheRetention) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
        sessionId,
        ws,
        new Date().toISOString(),
        fence,
        defaults.provider,
        defaults.id,
        defaults.thinking,
        effRetention,
      );
      return json({ sessionId, fence, revision: 0, model: { provider: defaults.provider, id: defaults.id }, thinking: defaults.thinking, retention: effRetention });
    }

    if (request.method === "POST" && url.pathname === "/git") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(ws, sid, "call POST /workspaces/:id/sessions/:sid/git on the Worker instead", MINT_WS_HINT);
      if (bad) return bad;
      let argv: unknown;
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object" && "argv" in body) {
          argv = body.argv;
        }
      } catch {
        argv = undefined;
      }
      const gate = gateArgv(argv);
      if (!gate.ok) return err(gate.error, gate.hint, gate.status);
      try {
        const rows = [
          ...this.state.storage.sql.exec("SELECT path, body FROM files WHERE ws = ?", ws),
        ] as unknown as Array<{ path: string; body: ArrayBuffer | Uint8Array }>;
        const files = rows.map((r) => ({
          path: r.path,
          body: r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body),
        }));
        if (gate.sub !== "init" && !hasGitDir(files)) return json(notARepoBody(), 404);
        const fs = createWorkspaceFs(files);
        if (gate.sub in WRITE_SUBCOMMANDS) {
          const result = await runGitWrite(fs, gate.sub, gate.rest);
          const now = new Date().toISOString();
          const dirty = fs.dirty();
          const sql = this.state.storage.sql;
          runInSyncTx(sql, () => {
            for (const up of dirty.upserts) {
              sql.exec(
                "INSERT OR REPLACE INTO files(ws, path, body, updated_at) VALUES (?, ?, ?, ?)",
                ws,
                up.path,
                up.body,
                now,
              );
            }
            for (const del of dirty.deletes) {
              sql.exec("DELETE FROM files WHERE ws = ? AND path = ?", ws, del);
            }
          });
          return json({ ...result, exitCode: 0 });
        }
        const result = await runGitRead(fs, gate.sub, gate.rest);
        return json({ ...result, exitCode: 0 });
      } catch (e) {
        if (e instanceof NotARepoError) return json(notARepoBody(), 404);
        const msg = e instanceof Error ? e.message : String(e ?? "git failed");
        if (/not a git repository/i.test(msg)) return json(notARepoBody(), 404);
        return err(msg.slice(0, 300), "retry with argv [status|log|diff|show|add|commit|rm|checkout|switch|init]; clone/fetch/push are forbidden", 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(ws, sid, "call POST /workspaces/:id/sessions/:sid/claim on the Worker instead", MINT_WS_HINT);
      if (bad) return bad;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
      return this.enqueueSessionTurn(sid, async () => {
        const hint = "retry as POST /workspaces/:id/sessions/:sid/claim with JSON {fence, expected}";
        const rot = checkedRotate(this.readFence(sid), body, hint, (next) => this.rotateFence(sid, next));
        if (rot === null) return err("missing fence", hint, 400);
        if ("status" in rot) return json(rot.body, rot.status);
        return json({ sessionId: sid, fence: rot.fence, revision: rot.revision });
      });
    }

    if (request.method === "POST" && (url.pathname === "/model" || url.pathname === "/thinking")) {
      const isThinking = url.pathname === "/thinking";
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(
        ws,
        sid,
        isThinking
          ? "call POST /workspaces/:id/sessions/:sid/thinking on the Worker instead"
          : "call POST /workspaces/:id/sessions/:sid/model on the Worker instead",
        MINT_WS_HINT,
      );
      if (bad) return bad;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
      const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
      if (!isThinking) {
        let provider: unknown = rec["provider"];
        let id: unknown = rec["id"];
        if (typeof provider !== "string" || provider.length === 0 || typeof id !== "string" || id.length === 0) {
          try {
            const runtime = buildRuntime(this.env as unknown as RuntimeEnv);
            if (runtime.stub) {
              return err("no model key", "set a provider key as a Worker secret, then retry", 400);
            }
            provider = runtime.model.provider;
            id = runtime.model.id;
          } catch (e) {
            if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
              const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
              return err(e.error, hint, 400);
            }
            return err("unknown model", "retry with a catalog model", 400);
          }
        }
        if (typeof provider !== "string" || provider.length === 0 || typeof id !== "string" || id.length === 0) {
          return err("unknown model", "retry with a catalog model", 400);
        }
        try {
          resolveCatalogModel(provider, id);
        } catch (e) {
          if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
            const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
            return err(e.error, hint, 404);
          }
          return err("unknown model", "retry with a catalog model", 404);
        }
        const rot = checkedRotate(this.readFence(sid), body, "retry the model switch with both {fence, expected}, or omit both for the legacy path", (next) => this.rotateFence(sid, next));
        if (rot !== null && "status" in rot) return json(rot.body, rot.status);
        const sql = this.state.storage.sql;
        const from = this.readTriple(sid);
        runInSyncTx(sql, () => {
          sql.exec("UPDATE sessions SET modelProvider = ?, modelId = ? WHERE sid = ?", provider, id, sid);
          saveSettings(sql, ws, provider, id, this.readSettings(ws).thinking);
          appendEntry(sql, sid, "model_change", {
            from: { provider: from?.provider ?? null, id: from?.id ?? null },
            to: { provider, id },
          });
        });
        const cur = this.readFence(sid);
        return fmtModel(sid, provider, id, rot, cur?.revision ?? 0);
      }
      const level: unknown = rec["level"];
      if (typeof level !== "string" || level.length === 0) {
        return err("missing level", 'retry as POST /workspaces/:id/sessions/:sid/thinking with JSON {"level": "high"}', 400);
      }
      const triple = this.readTriple(sid);
      let like: RuntimeModel | Record<string, never> = {};
      if (triple?.provider !== null && triple?.provider !== undefined && triple?.id !== null && triple?.id !== undefined) {
        try {
          like = resolveCatalogModel(triple.provider as string, triple.id as string);
        } catch (e) {
          if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
            const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
            return err(e.error, hint, 404);
          }
          return err("unknown model", "retry with a catalog model", 404);
        }
      } else {
        try {
          const runtime = buildRuntime(this.env as unknown as RuntimeEnv);
          if (!runtime.stub) like = runtime.model;
        } catch {
          like = {};
        }
      }
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
        return err(`unknown thinking level: ${level}`, `supported levels: ${supportedThinkingLevels(like).join(", ")}`, 400);
      }
      const rotated = checkedRotate(this.readFence(sid), body, "retry the thinking switch with both {fence, expected}, or omit both for the legacy path", (next) => this.rotateFence(sid, next));
      if (rotated !== null && "status" in rotated) return json(rotated.body, rotated.status);
      const applied = clampThinkingLevel(like, level);
      const sql = this.state.storage.sql;
      runInSyncTx(sql, () => {
        sql.exec("UPDATE sessions SET thinkingLevel = ? WHERE sid = ?", applied, sid);
        appendEntry(sql, sid, "thinking_level_change", {
          from: triple?.thinking ?? null,
          requested: level,
          level: applied,
        });
      });
      const cur = this.readFence(sid);
      return fmtThinking(sid, applied, level, rotated, cur?.revision ?? 0);
    }

    if (url.pathname === "/settings") {
      const ws = url.searchParams.get("ws") ?? "";
      const bad = this.requireSession(ws, null, "call PUT /workspaces/:id/settings on the Worker instead", "create one with POST /workspaces first, then set its defaults");
      if (bad) return bad;
      if (request.method === "GET") {
        const current = this.readSettings(ws);
        return fmtSettings(ws, current);
      }
      if (request.method === "POST" || request.method === "PUT") {
        let patchProvider: unknown;
        let patchId: unknown;
        let patchThinking: unknown;
        let hasProvider = false;
        let hasId = false;
        let hasThinking = false;
        try {
          const body: unknown = await request.json();
          if (body !== null && typeof body === "object") {
            if ("modelProvider" in body) {
              patchProvider = body.modelProvider;
              hasProvider = true;
            }
            if ("modelId" in body) {
              patchId = body.modelId;
              hasId = true;
            }
            if ("thinkingLevel" in body) {
              patchThinking = body.thinkingLevel;
              hasThinking = true;
            }
          }
        } catch {
          return err("bad settings", 'retry as PUT /workspaces/:id/settings with JSON {"modelProvider": "anthropic", "modelId": "claude-opus-4-6", "thinkingLevel": "high"}; omit keys to leave them, null clears', 400);
        }
        for (const [name, value] of [["modelProvider", patchProvider], ["modelId", patchId], ["thinkingLevel", patchThinking]] as Array<[string, unknown]>) {
          if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0)) {
            return err(`bad settings: ${name}`, `set ${name} to a non-empty string, null to clear, or omit it to leave it`, 400);
          }
        }
        const current = this.readSettings(ws);
        const next = {
          provider: hasProvider ? (patchProvider as string | null) : current.provider,
          id: hasId ? (patchId as string | null) : current.id,
          thinking: hasThinking ? (patchThinking as string | null) : current.thinking,
        };
        if ((next.provider === null) !== (next.id === null)) {
          return err("half model default", "set both modelProvider and modelId, or clear both with null", 400);
        }
        if (next.provider !== null && next.id !== null) {
          try {
            resolveCatalogModel(next.provider, next.id);
          } catch (e) {
            if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
              const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
              return err(e.error, hint, 404);
          }
        }
        }
        if (next.thinking !== null && !(THINKING_LEVELS as readonly string[]).includes(next.thinking)) {
          return err(`unknown thinking level: ${next.thinking}`, `supported levels: ${(THINKING_LEVELS as readonly string[]).join(", ")}`, 400);
        }
        saveSettings(this.state.storage.sql, ws, next.provider, next.id, next.thinking);
        return fmtSettings(ws, next);
      }
      return err("method not allowed", "use GET or PUT /workspaces/:id/settings", 405);
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(ws, sid, "call POST /workspaces/:id/sessions/:sid/run on the Worker instead", MINT_WS_HINT);
      if (bad) return bad;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
      const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const prompt: unknown = rec["prompt"];
      const oneShotModel: unknown = "model" in rec ? rec["model"] : undefined;
      const oneShotThinking: unknown = "thinking" in rec ? rec["thinking"] : undefined;
      if (typeof prompt !== "string" || prompt.length === 0) {
        return err("missing prompt", 'retry as POST /workspaces/:id/sessions/:sid/run with JSON {"prompt": "read seed.txt"}', 400);
      }
      let overrideProvider: string | null = null;
      let overrideId: string | null = null;
      if (oneShotModel !== undefined) {
        if (typeof oneShotModel === "string") {
          const slash = oneShotModel.indexOf("/");
          if (slash > 0) {
            overrideProvider = oneShotModel.slice(0, slash);
            overrideId = oneShotModel.slice(slash + 1);
          }
        } else if (oneShotModel !== null && typeof oneShotModel === "object" && "provider" in oneShotModel && "id" in oneShotModel) {
          if (typeof oneShotModel.provider === "string" && typeof oneShotModel.id === "string") {
            overrideProvider = oneShotModel.provider;
            overrideId = oneShotModel.id;
          }
        }
        if (overrideProvider === null || overrideProvider.length === 0 || overrideId === null || overrideId.length === 0) {
          return err("bad model override", 'retry with {"model": {"provider": "anthropic", "id": "claude-opus-4-6"}} or {"model": "anthropic/claude-opus-4-6"}', 400);
        }
      }
      if (oneShotThinking !== undefined && (typeof oneShotThinking !== "string" || oneShotThinking.length === 0)) {
        return err("bad thinking override", 'retry with {"thinking": "high"} using a supported level', 400);
      }
      const stored = this.readTriple(sid);
      const effProvider = overrideProvider ?? stored?.provider ?? null;
      const effId = overrideId ?? stored?.id ?? null;
      let catalog: RuntimeModel | null = null;
      if (effProvider !== null && effId !== null) {
        try {
          const keyedHere = keyedProviders(this.env as unknown as RuntimeEnv);
          catalog = keyedHere.some((provider) => provider.id === effProvider)
            ? await resolveKeyedModelLive(this.env as unknown as RuntimeEnv, effProvider, effId)
            : resolveCatalogModel(effProvider, effId);
        } catch (e) {
          if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
            const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
            return err(e.error, hint, 404);
          }
          return err("unknown model", "retry with a catalog model", 404);
        }
      }
      const wantThinking = (oneShotThinking as string | undefined) ?? stored?.thinking ?? null;
      let like: RuntimeModel | Record<string, never> = catalog ?? {};
      if (catalog === null && wantThinking !== null) {
        try {
          const fallback = buildRuntime(this.env as unknown as RuntimeEnv);
          if (!fallback.stub) like = fallback.model;
        } catch {
          like = {};
        }
      }
      if (oneShotThinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(oneShotThinking as string)) {
        return err(`unknown thinking level: ${oneShotThinking as string}`, `supported levels: ${supportedThinkingLevels(like).join(", ")}`, 400);
      }
      const effThinking = wantThinking === null ? null : clampThinkingLevel(like, wantThinking);
      return this.enqueueSessionTurn(sid, async () => {
        const rot = checkedRotate(this.readFence(sid), body, "retry the run with both {fence, expected}, or omit both for the legacy path", (next) => this.rotateFence(sid, next));
        if (rot !== null && "status" in rot) return json(rot.body, rot.status);
        const rotated = rot;
        const sql = this.state.storage.sql;
        const runId = crypto.randomUUID();
        let response: Response | null = null;
        const sink: TurnSink = {
          push() {},
          done(doneId, turn, runtime) {
            recordTurnWithOpen(sql, sid, doneId, prompt, turn.toolCalls, turn.result, turn.usage, turn.halt ?? null);
            const out = { result: turn.result, toolCalls: turn.toolCalls, runtime, usage: turn.usage, ...(turn.halt ? { halt: turn.halt } : {}) };
            response = rotated !== null ? json({ ...out, fence: rotated.fence, revision: rotated.revision }) : json(out);
          },
          fail(failId, error, hint, status, opened) {
            if (opened) openRun(sql, sid, failId);
            response = json({ error, hint }, status);
          },
          aborted() {},
        };
        await executeTurn(this.streamHost(ws, sid), { prompt, catalog, thinking: effThinking, runId }, sink);
        return response ?? json({ error: "run failed", hint: "retry the run with a simpler prompt" }, 500);
      });
    }

    if (url.pathname === "/stream") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      return acceptStream(request, this.streamHost(ws, sid), this.state);
    }

    if (request.method === "GET" && url.pathname === "/entries") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(ws, sid, "retry as GET /workspaces/:id/sessions/:sid/entries on the Worker instead", MINT_WS_HINT);
      if (bad) return bad;
      const rawAfter = url.searchParams.get("after") ?? "0";
      const after = Number(rawAfter);
      if (!Number.isInteger(after) || after < 0) {
        return err("bad after", "retry with ?after=N where N is a non-negative cursor, e.g. ?after=0", 400);
      }
      const rawLimit = url.searchParams.get("limit") ?? "100";
      const limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 0) {
        return err("bad limit", "retry with ?limit=L where L is a non-negative integer up to 1000, e.g. ?limit=100", 400);
      }
      const sql = this.state.storage.sql;
      const { count, head } = entryHead(sql, sid);
      return json({ entries: listEntries(sql, sid, { after, limit }), head, count });
    }

    if (request.method === "GET" && url.pathname === "/meta") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(ws, sid, "retry as GET /workspaces/:id/sessions/:sid/meta on the Worker instead", MINT_WS_HINT);
      if (bad) return bad;
      const sql = this.state.storage.sql;
      let created = "";
      for (const row of sql.exec("SELECT created_at FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws)) {
        if (row !== null && typeof row === "object" && "created_at" in row && typeof row.created_at === "string") {
          created = row.created_at;
        }
      }
      const { count, head } = entryHead(sql, sid);
      let leaf = head;
      for (const row of sql.exec("SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid)) {
        if (row !== null && typeof row === "object" && "leaf" in row && typeof row.leaf === "number") {
          leaf = row.leaf;
        }
      }
      let openRun: string | null = null;
      for (const row of sql.exec("SELECT runId FROM runs WHERE sid = ? AND status = ? LIMIT 1", sid, "open")) {
        if (row !== null && typeof row === "object" && "runId" in row && typeof row.runId === "string") {
          openRun = row.runId;
        }
      }
      const triple = this.readTriple(sid);
      const archive = archiveMeta(sql, sid);
      const usage = fmtUsage(sumResultUsage(sql, sid), this.sessionContextWindow(triple));
      return json({ sid, ws, created, head, count, leaf, openRun, model: { provider: triple?.provider ?? null, id: triple?.id ?? null }, thinking: triple?.thinking ?? null, retention: triple?.retention ?? "short", usage, compaction: { pending: compactionPending(sql, sid), archivePages: archive.pages, archiveTotal: archive.total } });
    }

    if (request.method === "POST" && url.pathname === "/compact") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(ws, sid, "retry as POST /workspaces/:id/sessions/:sid/compact on the Worker instead", MINT_WS_HINT);
      if (bad) return bad;
      return this.enqueueSessionTurn(sid, async () => {
        const out = runCompaction(this.state.storage.sql, sid, true);
        return json({ sid, ...out });
      });
    }

    if (request.method === "GET" && url.pathname === "/archive") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const bad = this.requireSession(ws, sid, "retry as GET /workspaces/:id/sessions/:sid/archive on the Worker instead", MINT_WS_HINT);
      if (bad) return bad;
      const page = Number(url.searchParams.get("page") ?? "1");
      if (!Number.isInteger(page) || page < 1) {
        return err("bad page", "retry with ?page=N where N is a positive integer, e.g. ?page=1", 400);
      }
      const sql = this.state.storage.sql;
      return json({ sid, ...readArchivePage(sql, sid, page) });
    }
    if (request.method === "POST" && url.pathname === "/exec") {
      const ws = url.searchParams.get("ws") ?? "";
      const parsed = await readValidated(request, "exec", execSchema);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const bad = this.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;
      let result;
      try {
        result = await this.env.SHELL_WORKER.exec({ command: body.command, cwd: body.cwd, env: body.env, sid: body.sid });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("exec busy")) {
          return err(message, "wait for the run to settle, or stop it via POST /workspaces/:id/exec/kill", 409);
        }
        if (message.startsWith("exec sessions full")) {
          return err(message, "drop an idle session via POST /workspaces/:id/exec/dispose, then retry", 429);
        }
        if (message.startsWith("exec cwd escapes")) {
          return err(message, 'stay under /workspace, e.g. {"command": "pwd", "cwd": "/workspace"}', 400);
        }
        throw e;
      }
      if (result.killed) {
        return err("exec killed by kill request", "retry the command, or drop the session via POST /workspaces/:id/exec/dispose", 408);
      }
      if (result.timedOut) {
        return err(`exec timed out after ${EXEC_TIMEOUT_MS}ms`, "retry with a shorter command, or stop a live run via POST /workspaces/:id/exec/kill", 408);
      }
      return json({ stdout: result.stdout, stderr: result.stderr, exit: result.exit });
    }

    if (request.method === "POST" && url.pathname === "/exec/kill") {
      const ws = url.searchParams.get("ws") ?? "";
      const parsed = await readValidated(request, "execKill", sidSchema);
      if (!parsed.ok) return parsed.response;
      const bad = this.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;
      try {
        const outcome = await this.env.SHELL_WORKER.kill({ sid: parsed.value.sid });
        return json({ killed: outcome.killed });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("no such exec session")) {
          return err(message, "run one command with that sid first to create the session", 404);
        }
        throw e;
      }
    }

    if (request.method === "POST" && url.pathname === "/exec/dispose") {
      const ws = url.searchParams.get("ws") ?? "";
      const parsed = await readValidated(request, "execDispose", sidSchema);
      if (!parsed.ok) return parsed.response;
      const bad = this.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;
      const outcome = await this.env.SHELL_WORKER.dispose({ sid: parsed.value.sid });
      return json({ disposed: outcome.disposed, stdoutBytes: outcome.stdoutBytes, stderrBytes: outcome.stderrBytes });
    }

    if (request.method === "POST" && url.pathname === "/bg") {
      const ws = url.searchParams.get("ws") ?? "";
      const parsed = await readValidated(request, "bg", bgSchema);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const bad = this.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;
      try {
        const outcome = await this.env.SHELL_WORKER.bgStart({ command: body.command, cwd: body.cwd, env: body.env });
        return json({ handle: outcome.handle });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("exec cwd escapes")) {
          return err(message, 'stay under /workspace, e.g. {"command": "pwd", "cwd": "/workspace"}', 400);
        }
        if (message.startsWith("bg processes full")) {
          return err(message, "kill a running process via POST /workspaces/:id/bg/kill, then retry", 429);
        }
        throw e;
      }
    }

    if (request.method === "GET" && url.pathname === "/bg") {
      const ws = url.searchParams.get("ws") ?? "";
      const bad = this.requireSession(ws, null, "call GET /workspaces/:id/bg on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;
      const handle = url.searchParams.get("handle");
      if (handle === null || handle.length === 0) {
        return err("missing handle", "retry as GET /workspaces/:id/bg?handle=H with the handle from POST /workspaces/:id/bg", 400);
      }
      try {
        return json(await this.env.SHELL_WORKER.bgRead({ handle }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("no such bg process")) {
          return err(message, "start one with POST /workspaces/:id/bg first, or it was killed", 404);
        }
        throw e;
      }
    }

    if (request.method === "POST" && url.pathname === "/bg/kill") {
      const ws = url.searchParams.get("ws") ?? "";
      const parsed = await readValidated(request, "bgKill", handleSchema);
      if (!parsed.ok) return parsed.response;
      const bad = this.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
      if (bad) return bad;
      try {
        const outcome = await this.env.SHELL_WORKER.bgKill({ handle: parsed.value.handle });
        return json({ killed: outcome.killed });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("no such bg process")) {
          return err(message, "start one with POST /workspaces/:id/bg first, or it was killed", 404);
        }
        throw e;
      }
    }

    if (request.method === "GET" && url.pathname === "/models") {
      const only = url.searchParams.get("provider");
      const models = listCatalogModels().filter((m) => only === null || m.provider === only);
      if (only !== null && models.length === 0) {
        return err(`unknown provider: ${only}`, "retry GET /models without ?provider to list the catalog", 404);
      }
      const keyed = keyedProviders(this.env as unknown as RuntimeEnv).map((provider) => provider.id);
      return json({ models, keyed });
    }

    return err("not found", "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files", 404);
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    const sql = this.state.storage.sql;
    for (const sid of pendingSessions(sql)) {
      try {
        runCompaction(sql, sid);
      } catch (e) {
        appendEntry(sql, sid, "error", { error: e instanceof Error ? e.message : String(e ?? "compaction failed") });
      }
    }
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
    await socketMessage(this.streamHost(att.ws, att.sid), wrapSocket(ws), message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = readAttachment(ws);
    if (att !== null) socketClosed(this.streamHost(att.ws, att.sid));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const att = readAttachment(ws);
    if (att !== null) socketClosed(this.streamHost(att.ws, att.sid));
  }
}
