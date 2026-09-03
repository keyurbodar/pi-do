import { createDofsVfs, type FileStore } from "./vfs-dofs";
import { appendEntry, ensureEntriesSchema, entryHead, listEntries, openRun, recordTurnWithOpen, runInSyncTx, sumResultUsage, withSessionRates } from "./entries";
import { archiveMeta, compactionPending, ensureCompactionSchema, maybeMarkForCompaction, pendingSessions, readArchivePage, runCompaction } from "./compaction";
import { enforceFence } from "./fence";
import { acceptStream, readAttachment, socketClosed, socketMessage, wrapSocket, type StreamHost } from "./stream";
import { createAgentSession } from "../../packages/pi-cf/src/session";
import { normalizeWorkspacePath } from "../../packages/pi-cf/src/tools";
import { buildRuntime, clampThinkingLevel, keyedProviders, resolveCatalogModel, resolveKeyedModel, resolveProviderKey, supportedThinkingLevels, THINKING_LEVELS, type RuntimeEnv, type RuntimeModel } from "./model-runtime";
import { createWorkspaceFs, hasGitDir } from "./git-fs";
import { gateArgv, notARepoBody, NotARepoError, runGitRead } from "./git-reads";
interface ShellWorkerBinding {
  exec(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    sid?: string;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean; killed: boolean }>;
  kill(input: { sid: string }): Promise<{ killed: boolean }>;
  dispose(input: { sid: string }): Promise<{ disposed: true }>;
}
interface Env {
  WORKSPACE_DO: DurableObjectNamespace;
  SHELL_WORKER: ShellWorkerBinding;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class WorkspaceDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private files: FileStore;
  // Ephemeral liveness witnesses for stream turns, one per incarnation. An
  // eviction resets this map; correctness state stays in SQLite, and the next
  // openRun flips any orphaned run to interrupted.
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
    sql.exec(
      "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, created_at TEXT)",
    );
    this.files.ensureSchema();
    ensureEntriesSchema(sql);
    ensureCompactionSchema(sql);
    sql.exec("DROP TABLE IF EXISTS pi_owners");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, ws TEXT, created_at TEXT, ownerFence TEXT, revision INTEGER NOT NULL DEFAULT 0)",
    );
    const cols = [
      ...sql.exec("PRAGMA table_info(sessions)"),
    ] as Array<{ name?: unknown }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("ownerFence")) sql.exec("ALTER TABLE sessions ADD COLUMN ownerFence TEXT");
    if (!names.has("revision"))
      sql.exec("ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    if (!names.has("modelProvider")) sql.exec("ALTER TABLE sessions ADD COLUMN modelProvider TEXT");
    if (!names.has("modelId")) sql.exec("ALTER TABLE sessions ADD COLUMN modelId TEXT");
    if (!names.has("thinkingLevel")) sql.exec("ALTER TABLE sessions ADD COLUMN thinkingLevel TEXT");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS workspace_settings(ws TEXT PRIMARY KEY, modelProvider TEXT, modelId TEXT, thinkingLevel TEXT)",
    );
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
  private readTriple(sid: string): { provider: string | null; id: string | null; thinking: string | null } | null {
    const rows = [
      ...this.state.storage.sql.exec("SELECT modelProvider, modelId, thinkingLevel FROM sessions WHERE sid = ?", sid),
    ] as Array<{ modelProvider?: unknown; modelId?: unknown; thinkingLevel?: unknown }>;
    if (rows.length === 0) return null;
    const raw = rows[0];
    return {
      provider: typeof raw.modelProvider === "string" ? raw.modelProvider : null,
      id: typeof raw.modelId === "string" ? raw.modelId : null,
      thinking: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : null,
    };
  }

  // resolveCatalogModel throws on unknown ids; meta reports null instead of guessing.
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
        return json(
          {
            error: "missing workspaceId",
            hint: "POST /workspaces on the Worker to mint a workspace id",
          },
          400,
        );
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
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call POST /workspaces/:id/exec on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first",
          },
          404,
        );
      }
      return json({ workspaceId: ws, exists: true });
    }

    if (url.pathname === "/files") {
      const ws = url.searchParams.get("ws") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call PUT /workspaces/:id/files?path=P on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first",
          },
          404,
        );
      }

      if (request.method === "PUT") {
        const path = url.searchParams.get("path");
        if (!path) {
          return json(
            {
              error: "missing path",
              hint: "retry as PUT /workspaces/:id/files?path=P with raw bytes",
            },
            400,
          );
        }
        const buf = new Uint8Array(await request.arrayBuffer());
        const bytes = this.files.put(ws, path, buf, new Date().toISOString());
        return json({ path, bytes });
      }
      if (request.method === "DELETE") {
        const rawPath = url.searchParams.get("path");
        if (!rawPath) {
          return json(
            {
              error: "missing path",
              hint: "retry as DELETE /workspaces/:id/files?path=P",
            },
            400,
          );
        }
        let path: string;
        try {
          path = normalizeWorkspacePath(rawPath);
        } catch (e) {
          if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
            const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a workspace-relative path";
            return json({ error: e.error, hint }, 400);
          }
          throw e;
        }
        if (path === "") {
          return json(
            {
              error: "bad path",
              hint: "refusing to remove the workspace root; retry with a file or directory path",
            },
            400,
          );
        }
        if (this.files.exists(ws, path)) {
          this.files.remove(ws, path);
          return json({ removed: [path] });
        }
        const under = this.files.list(ws, `${path}/`);
        if (under.length === 0) {
          return json(
            {
              error: `no such file: ${path}`,
              hint: "check the path with files ls first, then retry",
            },
            404,
          );
        }
        if (url.searchParams.get("recursive") !== "true") {
          return json(
            {
              error: `${path} is a directory`,
              hint: "retry with ?recursive=true to delete the whole tree, or remove files one by one",
            },
            400,
          );
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
          return json(
            {
              error: "missing path",
              hint: "retry as GET /workspaces/:id/files?path=P, or list with ?list=DIR",
            },
            400,
          );
        }
        const body = this.files.get(ws, path);
        if (body === undefined) {
          return json(
            {
              error: `no such file: ${path}`,
              hint: "upload it with PUT /workspaces/:id/files?path=P first",
            },
            404,
          );
        }
        return new Response(body as BodyInit, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
    }

    if (request.method === "POST" && url.pathname === "/sessions") {
      const ws = url.searchParams.get("ws") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call POST /workspaces/:id/sessions on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then POST /workspaces/:id/sessions",
          },
          404,
        );
      }
      const sessionId = crypto.randomUUID();
      const fence = crypto.randomUUID();
      const defaults = this.readSettings(ws);
      this.state.storage.sql.exec(
        "INSERT INTO sessions(sid, ws, created_at, ownerFence, revision, modelProvider, modelId, thinkingLevel) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
        sessionId,
        ws,
        new Date().toISOString(),
        fence,
        defaults.provider,
        defaults.id,
        defaults.thinking,
      );
      return json({ sessionId, fence, revision: 0, model: { provider: defaults.provider, id: defaults.id }, thinking: defaults.thinking });
    }

    if (request.method === "POST" && url.pathname === "/git") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          { error: "missing workspace", hint: "call POST /workspaces/:id/sessions/:sid/git on the Worker instead" },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      let argv: unknown;
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object" && "argv" in body) {
          argv = body.argv;
        }
      } catch {
        argv = undefined;
      }
      // Allowlist gate first: nothing executes below for 403/501.
      const gate = gateArgv(argv);
      if (!gate.ok) return json({ error: gate.error, hint: gate.hint }, gate.status);
      // Allowed read: snapshot the files table once, run isomorphic-git over it.
      // No .git tree at all is deterministically not-a-repo: answer 404 here so
      // isomorphic-git's low-level ENOENT probes never surface as a 500/400.
      try {
        const rows = [
          ...this.state.storage.sql.exec("SELECT path, body FROM files WHERE ws = ?", ws),
        ] as unknown as Array<{ path: string; body: ArrayBuffer | Uint8Array }>;
        const files = rows.map((r) => ({
          path: r.path,
          body: r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body),
        }));
        if (!hasGitDir(files)) return json(notARepoBody(), 404);
        const fs = createWorkspaceFs(files);
        const result = await runGitRead(fs, gate.sub, gate.rest);
        return json({ ...result, exitCode: 0 });
      } catch (e) {
        if (e instanceof NotARepoError) return json(notARepoBody(), 404);
        const msg = e instanceof Error ? e.message : String(e ?? "git failed");
        if (/not a git repository/i.test(msg)) return json(notARepoBody(), 404);
        return json(
          { error: msg.slice(0, 300), hint: "retry with argv [status|log|diff|show]; writes are deferred" },
          400,
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call POST /workspaces/:id/sessions/:sid/claim on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      let fence: unknown;
      let expected: unknown;
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object") {
          if ("fence" in body) fence = body.fence;
          if ("expected" in body) expected = body.expected;
        }
      } catch {
        fence = undefined;
        expected = undefined;
      }
      if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
        return json(
          {
            error: "missing fence",
            hint: "retry as POST /workspaces/:id/sessions/:sid/claim with JSON {fence, expected}",
          },
          400,
        );
      }
      const checked = enforceFence(this.readFence(sid), fence, expected);
      if ("status" in checked) return json(checked.body, checked.status);
      this.rotateFence(sid, checked);
      return json({ sessionId: sid, fence: checked.fence, revision: checked.revision });
    }

    if (request.method === "POST" && url.pathname === "/model") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call POST /workspaces/:id/sessions/:sid/model on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      let provider: unknown;
      let id: unknown;
      let fence: unknown;
      let expected: unknown;
      let hasFence = false;
      let hasExpected = false;
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object") {
          if ("provider" in body) provider = body.provider;
          if ("id" in body) id = body.id;
          if ("fence" in body) {
            fence = body.fence;
            hasFence = true;
          }
          if ("expected" in body) {
            expected = body.expected;
            hasExpected = true;
          }
        }
      } catch {
        provider = undefined;
        id = undefined;
      }
      if (typeof provider !== "string" || provider.length === 0 || typeof id !== "string" || id.length === 0) {
        return json(
          {
            error: "missing model",
            hint: 'retry as POST /workspaces/:id/sessions/:sid/model with JSON {"provider": "anthropic", "id": "claude-opus-4-6"}',
          },
          400,
        );
      }
      try {
        resolveCatalogModel(provider, id);
      } catch (e) {
        if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
          const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
          return json({ error: e.error, hint }, 404);
        }
        return json({ error: "unknown model", hint: "retry with a catalog model" }, 404);
      }
      let rotated: { fence: string; revision: number } | null = null;
      if (hasFence || hasExpected) {
        if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
          return json(
            {
              error: "missing fence",
              hint: "retry the model switch with both {fence, expected}, or omit both for the legacy path",
            },
            400,
          );
        }
        const checked = enforceFence(this.readFence(sid), fence, expected);
        if ("status" in checked) return json(checked.body, checked.status);
        this.rotateFence(sid, checked);
        rotated = checked;
      }
      const sql = this.state.storage.sql;
      const from = this.readTriple(sid);
      runInSyncTx(sql, () => {
        sql.exec("UPDATE sessions SET modelProvider = ?, modelId = ? WHERE sid = ?", provider, id, sid);
        appendEntry(sql, sid, "model_change", {
          from: { provider: from?.provider ?? null, id: from?.id ?? null },
          to: { provider, id },
        });
      });
      const cur = this.readFence(sid);
      if (rotated !== null) {
        return json({ sessionId: sid, model: { provider, id }, fence: rotated.fence, revision: rotated.revision });
      }
      return json({ sessionId: sid, model: { provider, id }, revision: cur?.revision ?? 0 });
    }

    if (request.method === "POST" && url.pathname === "/thinking") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call POST /workspaces/:id/sessions/:sid/thinking on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      let level: unknown;
      let fence: unknown;
      let expected: unknown;
      let hasFence = false;
      let hasExpected = false;
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object") {
          if ("level" in body) level = body.level;
          if ("fence" in body) {
            fence = body.fence;
            hasFence = true;
          }
          if ("expected" in body) {
            expected = body.expected;
            hasExpected = true;
          }
        }
      } catch {
        level = undefined;
      }
      if (typeof level !== "string" || level.length === 0) {
        return json(
          {
            error: "missing level",
            hint: 'retry as POST /workspaces/:id/sessions/:sid/thinking with JSON {"level": "high"}',
          },
          400,
        );
      }
      const triple = this.readTriple(sid);
      let like: RuntimeModel | Record<string, never> = {};
      if (triple?.provider !== null && triple?.provider !== undefined && triple?.id !== null && triple?.id !== undefined) {
        try {
          like = resolveCatalogModel(triple.provider as string, triple.id as string);
        } catch (e) {
          if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
            const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
            return json({ error: e.error, hint }, 404);
          }
          return json({ error: "unknown model", hint: "retry with a catalog model" }, 404);
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
        return json(
          {
            error: `unknown thinking level: ${level}`,
            hint: `supported levels: ${supportedThinkingLevels(like).join(", ")}`,
          },
          400,
        );
      }
      let rotated: { fence: string; revision: number } | null = null;
      if (hasFence || hasExpected) {
        if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
          return json(
            {
              error: "missing fence",
              hint: "retry the thinking switch with both {fence, expected}, or omit both for the legacy path",
            },
            400,
          );
        }
        const checked = enforceFence(this.readFence(sid), fence, expected);
        if ("status" in checked) return json(checked.body, checked.status);
        this.rotateFence(sid, checked);
        rotated = checked;
      }
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
      if (rotated !== null) {
        return json({ sessionId: sid, thinking: applied, requested: level, fence: rotated.fence, revision: rotated.revision });
      }
      return json({ sessionId: sid, thinking: applied, requested: level, revision: cur?.revision ?? 0 });
    }

    if (url.pathname === "/settings") {
      const ws = url.searchParams.get("ws") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call PUT /workspaces/:id/settings on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then set its defaults",
          },
          404,
        );
      }
      if (request.method === "GET") {
        const current = this.readSettings(ws);
        return json({ ws, settings: { modelProvider: current.provider, modelId: current.id, thinkingLevel: current.thinking } });
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
          return json(
            {
              error: "bad settings",
              hint: 'retry as PUT /workspaces/:id/settings with JSON {"modelProvider": "anthropic", "modelId": "claude-opus-4-6", "thinkingLevel": "high"}; omit keys to leave them, null clears',
            },
            400,
          );
        }
        for (const [name, value] of [["modelProvider", patchProvider], ["modelId", patchId], ["thinkingLevel", patchThinking]] as Array<[string, unknown]>) {
          if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0)) {
            return json(
              {
                error: `bad settings: ${name}`,
                hint: `set ${name} to a non-empty string, null to clear, or omit it to leave it`,
              },
              400,
            );
          }
        }
        const current = this.readSettings(ws);
        const next = {
          provider: hasProvider ? (patchProvider as string | null) : current.provider,
          id: hasId ? (patchId as string | null) : current.id,
          thinking: hasThinking ? (patchThinking as string | null) : current.thinking,
        };
        if ((next.provider === null) !== (next.id === null)) {
          return json(
            {
              error: "half model default",
              hint: "set both modelProvider and modelId, or clear both with null",
            },
            400,
          );
        }
        if (next.provider !== null && next.id !== null) {
          try {
            resolveCatalogModel(next.provider, next.id);
          } catch (e) {
            if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
              const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
              return json({ error: e.error, hint }, 404);
            }
            return json({ error: "unknown model", hint: "retry with a catalog model" }, 404);
          }
        }
        if (next.thinking !== null && !(THINKING_LEVELS as readonly string[]).includes(next.thinking)) {
          return json(
            {
              error: `unknown thinking level: ${next.thinking}`,
              hint: `supported levels: ${(THINKING_LEVELS as readonly string[]).join(", ")}`,
            },
            400,
          );
        }
        this.state.storage.sql.exec(
          "INSERT OR REPLACE INTO workspace_settings(ws, modelProvider, modelId, thinkingLevel) VALUES (?, ?, ?, ?)",
          ws,
          next.provider,
          next.id,
          next.thinking,
        );
        return json({ ws, settings: { modelProvider: next.provider, modelId: next.id, thinkingLevel: next.thinking } });
      }
      return json(
        { error: "method not allowed", hint: "use GET or PUT /workspaces/:id/settings" },
        405,
      );
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "call POST /workspaces/:id/sessions/:sid/run on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      let prompt: unknown;
      let fence: unknown;
      let expected: unknown;
      let hasFence = false;
      let hasExpected = false;
      let oneShotModel: unknown;
      let oneShotThinking: unknown;
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object") {
          if ("prompt" in body) prompt = body.prompt;
          if ("fence" in body) {
            fence = body.fence;
            hasFence = true;
          }
          if ("expected" in body) {
            expected = body.expected;
            hasExpected = true;
          }
          if ("model" in body) oneShotModel = body.model;
          if ("thinking" in body) oneShotThinking = body.thinking;
        }
      } catch {
        prompt = undefined;
      }
      if (typeof prompt !== "string" || prompt.length === 0) {
        return json(
          {
            error: "missing prompt",
            hint: 'retry as POST /workspaces/:id/sessions/:sid/run with JSON {"prompt": "read seed.txt"}',
          },
          400,
        );
      }
      // One-shot overrides: validated like the switch routes, persist nothing.
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
          return json(
            {
              error: "bad model override",
              hint: 'retry with {"model": {"provider": "anthropic", "id": "claude-opus-4-6"}} or {"model": "anthropic/claude-opus-4-6"}',
            },
            400,
          );
        }
      }
      if (oneShotThinking !== undefined && (typeof oneShotThinking !== "string" || oneShotThinking.length === 0)) {
        return json(
          {
            error: "bad thinking override",
            hint: 'retry with {"thinking": "high"} using a supported level',
          },
          400,
        );
      }
      const stored = this.readTriple(sid);
      const effProvider = overrideProvider ?? stored?.provider ?? null;
      const effId = overrideId ?? stored?.id ?? null;
      let catalog: RuntimeModel | null = null;
      if (effProvider !== null && effId !== null) {
        try {
          catalog = resolveCatalogModel(effProvider, effId);
        } catch (e) {
          if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
            const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
            return json({ error: e.error, hint }, 404);
          }
          return json({ error: "unknown model", hint: "retry with a catalog model" }, 404);
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
        return json(
          {
            error: `unknown thinking level: ${oneShotThinking as string}`,
            hint: `supported levels: ${supportedThinkingLevels(like).join(", ")}`,
          },
          400,
        );
      }
      const effThinking = wantThinking === null ? null : clampThinkingLevel(like, wantThinking);
      return this.enqueueSessionTurn(sid, async () => {
      let rotated: { fence: string; revision: number } | null = null;
      if (hasFence || hasExpected) {
        if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
          return json(
            {
              error: "missing fence",
              hint: "retry the run with both {fence, expected}, or omit both for the legacy path",
            },
            400,
          );
        }
        const checked = enforceFence(this.readFence(sid), fence, expected);
        if ("status" in checked) return json(checked.body, checked.status);
        this.rotateFence(sid, checked);
        rotated = checked;
      }
      const sql = this.state.storage.sql;
      const runId = crypto.randomUUID();
      try {
        let turnModel: { id: string; name?: string; api?: string; provider?: string; baseUrl?: string };
        let respProvider: string;
        if (catalog !== null) {
          // Session triple (or one-shot) wins over env-only resolution. Keyed
          // providers run the real model; keyless keeps the stub path, which
          // ignores the model and records its id on the turn.
          const keyed = keyedProviders(this.env as unknown as RuntimeEnv);
          if (keyed.length === 0) {
            turnModel = { id: catalog.id };
            respProvider = catalog.provider;
          } else {
            try {
              const keyedModel = resolveKeyedModel(this.env as unknown as RuntimeEnv, catalog.provider, catalog.id);
              turnModel = keyedModel;
              respProvider = keyedModel.provider;
            } catch (e) {
              if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
                const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
                return json({ error: e.error, hint }, 404);
              }
              return json({ error: "unknown model", hint: "retry with a catalog model" }, 404);
            }
          }
        } else {
          const runtime = buildRuntime(this.env as unknown as RuntimeEnv);
          turnModel = runtime.model;
          respProvider = runtime.model.provider;
        }
        const session = createAgentSession({
          files: this.files,
          ws,
          shell: this.env.SHELL_WORKER,
          model: turnModel,
          apiKey: resolveProviderKey(this.env as unknown as RuntimeEnv, respProvider),
        });
        const turn = await session.run(prompt, { thinking: effThinking });
        recordTurnWithOpen(sql, sid, runId, prompt, turn.toolCalls, turn.result, turn.usage);
        // Window reserve: mark for compaction but never compact inside the turn. The alarm runs seconds later so a burst of turns settles into one compaction.
        if (maybeMarkForCompaction(sql, sid)) await this.state.storage.setAlarm(Date.now() + 2000);
        const runtimeOut = { via: turn.via, model: turn.model, provider: respProvider, thinking: effThinking };
        if (rotated !== null) {
          return json({
            result: turn.result,
            toolCalls: turn.toolCalls,
            runtime: runtimeOut,
            usage: turn.usage,
            fence: rotated.fence,
            revision: rotated.revision,
          });
        }
        return json({
          result: turn.result,
          toolCalls: turn.toolCalls,
          runtime: runtimeOut,
          usage: turn.usage,
        });
      } catch (e) {
        // The open now commits with the turn, so a failed turn re-opens here
        // and still flips to interrupted on the next turn.
        openRun(sql, sid, runId);
        if (
          e !== null &&
          typeof e === "object" &&
          "error" in e &&
          typeof e.error === "string"
        ) {
          const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry the run";
          return json({ error: e.error, hint }, 500);
        }
        return json(
          { error: "run failed", hint: "retry the run with a simpler prompt" },
          500,
        );
      }
      });
    }

    // GET /stream?ws=&sid= — hibernation WS upgrade for live turns (see stream.ts).
    if (url.pathname === "/stream") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      return acceptStream(request, this.streamHost(ws, sid), this.state);
    }

    // GET /entries?ws=&sid=&after=N&limit=L — ordered replay slice plus resume cursor.
    if (request.method === "GET" && url.pathname === "/entries") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "retry as GET /workspaces/:id/sessions/:sid/entries on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      const rawAfter = url.searchParams.get("after") ?? "0";
      const after = Number(rawAfter);
      if (!Number.isInteger(after) || after < 0) {
        return json(
          {
            error: "bad after",
            hint: "retry with ?after=N where N is a non-negative cursor, e.g. ?after=0",
          },
          400,
        );
      }
      const rawLimit = url.searchParams.get("limit") ?? "100";
      const limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 0) {
        return json(
          {
            error: "bad limit",
            hint: "retry with ?limit=L where L is a non-negative integer up to 1000, e.g. ?limit=100",
          },
          400,
        );
      }
      const sql = this.state.storage.sql;
      const { count, head } = entryHead(sql, sid);
      return json({ entries: listEntries(sql, sid, { after, limit }), head, count });
    }

    // GET /meta?ws=&sid= — resume cursor: session row plus entry head and open run.
    if (request.method === "GET" && url.pathname === "/meta") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "retry as GET /workspaces/:id/sessions/:sid/meta on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      const sql = this.state.storage.sql;
      let created = "";
      for (const row of sql.exec("SELECT created_at FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws)) {
        if (row !== null && typeof row === "object" && "created_at" in row && typeof row.created_at === "string") {
          created = row.created_at;
        }
      }
      const { count, head } = entryHead(sql, sid);
      let openRun: string | null = null;
      for (const row of sql.exec("SELECT runId FROM runs WHERE sid = ? AND status = ? LIMIT 1", sid, "open")) {
        if (row !== null && typeof row === "object" && "runId" in row && typeof row.runId === "string") {
          openRun = row.runId;
        }
      }
      const triple = this.readTriple(sid);
      const archive = archiveMeta(sql, sid);
      const sums = sumResultUsage(sql, sid);
      const usage = withSessionRates(sums, this.sessionContextWindow(triple));
      return json({ sid, ws, created, head, count, openRun, model: { provider: triple?.provider ?? null, id: triple?.id ?? null }, thinking: triple?.thinking ?? null, usage, compaction: { pending: compactionPending(sql, sid), archivePages: archive.pages, archiveTotal: archive.total } });
    }

    // POST /compact?ws=&sid= — manual trigger; same runCompaction the alarm runs.
    if (request.method === "POST" && url.pathname === "/compact") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "retry as POST /workspaces/:id/sessions/:sid/compact on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      return this.enqueueSessionTurn(sid, async () => {
        const out = runCompaction(this.state.storage.sql, sid, true);
        return json({ sid, ...out });
      });
    }

    // GET /archive?ws=&sid=&page=N — re-read one paginated cold-storage page.
    if (request.method === "GET" && url.pathname === "/archive") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!ws) {
        return json(
          {
            error: "missing workspace",
            hint: "retry as GET /workspaces/:id/sessions/:sid/archive on the Worker instead",
          },
          400,
        );
      }
      if (!this.workspaceExists(ws)) {
        return json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first, then mint a session",
          },
          404,
        );
      }
      if (!sid || !this.sessionExists(ws, sid)) {
        return json(
          {
            error: "unknown session",
            hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
          },
          404,
        );
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      if (!Number.isInteger(page) || page < 1) {
        return json(
          {
            error: "bad page",
            hint: "retry with ?page=N where N is a positive integer, e.g. ?page=1",
          },
          400,
        );
      }
      const sql = this.state.storage.sql;
      return json({ sid, ...readArchivePage(sql, sid, page) });
    }

    return json(
      { error: "not found", hint: "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files" },
      404,
    );
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    const sql = this.state.storage.sql;
    for (const sid of pendingSessions(sql)) {
      try {
        runCompaction(sql, sid);
      } catch {
        continue;
      }
    }
  }

  private streamHost(ws: string, sid: string): StreamHost {
    return {
      sql: this.state.storage.sql,
      ws,
      sid,
      files: this.files,
      shell: this.env.SHELL_WORKER,
      runtimeEnv: this.env as unknown as RuntimeEnv,
      thinking: this.readTriple(sid)?.thinking ?? null,
      workspaceKnown: ws !== "" && this.workspaceExists(ws),
      sessionKnown: ws !== "" && sid !== "" && this.sessionExists(ws, sid),
      readFence: () => this.readFence(sid),
      casRotateFence: (oldFence, oldRevision, next) => this.casRotateFence(sid, oldFence, oldRevision, next),
      live: this.live,
      enqueue: (fn) => this.enqueueSessionTurn(sid, fn),
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
