import { createDofsVfs, type FileStore } from "./vfs-dofs.ts";
import {
  ensureEntriesSchema,
  entryHead,
  getEntry,
  listEntries,
  openRun,
  recordTurnWithOpen,
  sessionLeaf,
  sumResultUsage,
  withSessionRates,
  type EntriesSql,
} from "./entries.ts";
import { enforceFence } from "./fence.ts";
import {
  createAgentSession,
  sessionTools,
  type SessionModel,
  type SessionTools,
} from "./session.ts";
import type { ShellLike } from "./env.ts";
import { normalizeWorkspacePath } from "./tools.ts";

export { createAgentSession, sessionTools };
export type { SessionModel, SessionTools, ShellLike };

export interface CreatePiCfOptions {
  model?: SessionModel;
  tools?: Partial<SessionTools>;
  shell?: ShellLike;
  apiKey?: string;
}

export interface PiCfState {
  storage: { sql: EntriesSql };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const echoShell: ShellLike = {
  exec: async (input: { command: string; cwd?: string }) => {
    void input.cwd;
    const words = input.command;
    if (!words.startsWith("echo ") || /[&|;`$><#\\'"*!?(){}[\]~]/.test(words)) {
      throw {
        error: "shell unavailable",
        hint: "pass shell in createPiCf options to run commands on this host",
      };
    }
    return { stdout: `${words.slice(5)}\n`, stderr: "", exit: 0, timedOut: false };
  },
};

export function createPiCf(options: CreatePiCfOptions = {}): new (
  state: PiCfState,
) => { fetch(request: Request): Promise<Response> } {
  const model = options.model ?? { id: "stub" };
  const tools = options.tools;
  const shell = options.shell ?? echoShell;
  const apiKey = options.apiKey;

  return class PiCfAgent {
    private state: PiCfState;
    private files: FileStore;
    private queues = new Map<string, Promise<void>>();

    constructor(state: PiCfState) {
      this.state = state;
      this.files = createDofsVfs(state.storage.sql);
    }

    private ensureSchema(): void {
      const sql = this.state.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, created_at TEXT)");
      this.files.ensureSchema();
      ensureEntriesSchema(sql);
      sql.exec(
        "CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, ws TEXT, created_at TEXT, ownerFence TEXT, revision INTEGER NOT NULL DEFAULT 0)",
      );
      const cols = [...sql.exec("PRAGMA table_info(sessions)")] as Array<{ name?: unknown }>;
      if (cols.length > 0 && !cols.some((c) => c.name === "leaf")) {
        sql.exec("ALTER TABLE sessions ADD COLUMN leaf INTEGER NOT NULL DEFAULT 0");
      }
    }

    private enqueueSessionTurn<T>(sid: string, fn: () => Promise<T>): Promise<T> {
      const prev = this.queues.get(sid) ?? Promise.resolve();
      let release!: () => void;
      const cur = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prev.then(() => cur);
      this.queues.set(sid, tail);
      return prev.catch(() => {}).then(fn).finally(() => {
        release();
        if (this.queues.get(sid) === tail) this.queues.delete(sid);
      });
    }

    private readFence(sid: string): { fence: string | null; revision: number } | null {
      const rows = [
        ...this.state.storage.sql.exec("SELECT ownerFence, revision FROM sessions WHERE sid = ?", sid),
      ] as Array<{ ownerFence?: unknown; revision?: unknown }>;
      if (rows.length === 0) return null;
      const raw = rows[0];
      return {
        fence: typeof raw.ownerFence === "string" ? raw.ownerFence : null,
        revision: typeof raw.revision === "number" ? raw.revision : 0,
      };
    }

    private rotateFence(sid: string, next: { fence: string; revision: number }): void {
      this.state.storage.sql.exec("UPDATE sessions SET ownerFence = ?, revision = ? WHERE sid = ?", next.fence, next.revision, sid);
    }

    async fetch(request: Request): Promise<Response> {
      this.ensureSchema();
      const url = new URL(request.url);
      const sql = this.state.storage.sql;

      if (request.method === "POST" && url.pathname === "/create") {
        let workspaceId: string | undefined;
        try {
          workspaceId = ((await request.json()) as { workspaceId?: string }).workspaceId;
        } catch {
          workspaceId = undefined;
        }
        if (!workspaceId) {
          return json(
            { error: "missing workspaceId", hint: "POST /workspaces on the Worker to mint a workspace id" },
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

      if (request.method === "POST" && url.pathname === "/sessions") {
        const ws = url.searchParams.get("ws") ?? "";
        if (!ws) {
          return json(
            { error: "missing workspace", hint: "call POST /workspaces/:id/sessions on the Worker instead" },
            400,
          );
        }
        if ([...sql.exec("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1", ws)].length === 0) {
          return json(
            { error: "unknown workspace", hint: "create one with POST /workspaces first, then POST /workspaces/:id/sessions" },
            404,
          );
        }
        const sessionId = crypto.randomUUID();
        const fence = crypto.randomUUID();
        this.state.storage.sql.exec(
          "INSERT INTO sessions(sid, ws, created_at, ownerFence, revision) VALUES (?, ?, ?, ?, 0)",
          sessionId,
          ws,
          new Date().toISOString(),
          fence,
        );
        return json({ sessionId, fence, revision: 0 });
      }

      if (url.pathname === "/files") {
        const ws = url.searchParams.get("ws") ?? "";
        if (!ws) {
          return json(
            { error: "missing workspace", hint: "call PUT /workspaces/:id/files?path=P on the Worker instead" },
            400,
          );
        }
        if ([...sql.exec("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1", ws)].length === 0) {
          return json({ error: "unknown workspace", hint: "create one with POST /workspaces first" }, 404);
        }
        if (request.method === "PUT") {
          const path = url.searchParams.get("path");
          if (!path) {
            return json(
              { error: "missing path", hint: "retry as PUT /workspaces/:id/files?path=P with raw bytes" },
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
            return json({ error: "missing path", hint: "retry as DELETE /workspaces/:id/files?path=P" }, 400);
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
              { error: "bad path", hint: "refusing to remove the workspace root; retry with a file or directory path" },
              400,
            );
          }
          if (this.files.exists(ws, path)) {
            this.files.remove(ws, path);
            return json({ removed: [path] });
          }
          const under = this.files.list(ws, `${path}/`);
          if (under.length === 0) {
            return json({ error: `no such file: ${path}`, hint: "check the path with files ls first, then retry" }, 404);
          }
          if (url.searchParams.get("recursive") !== "true") {
            return json(
              { error: `${path} is a directory`, hint: "retry with ?recursive=true to delete the whole tree, or remove files one by one" },
              400,
            );
          }
          return json({ removed: this.files.removeTree(ws, `${path}/`) });
        }
        if (request.method === "GET") {
          if (url.searchParams.has("list")) {
            return json({ entries: this.files.list(ws, url.searchParams.get("list") ?? "") });
          }
          const path = url.searchParams.get("path");
          if (!path) {
            return json(
              { error: "missing path", hint: "retry as GET /workspaces/:id/files?path=P, or list with ?list=DIR" },
              400,
            );
          }
          const body = this.files.get(ws, path);
          if (body === undefined) {
            return json(
              { error: `no such file: ${path}`, hint: "upload it with PUT /workspaces/:id/files?path=P first" },
              404,
            );
          }
          return new Response(body as BodyInit, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
      }

      if (request.method === "POST" && url.pathname === "/claim") {
        const ws = url.searchParams.get("ws") ?? "";
        const sid = url.searchParams.get("sid") ?? "";
        if (!ws || [...sql.exec("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1", ws)].length === 0 || !sid || [...sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws)].length === 0) {
          const unknown = !ws || [...sql.exec("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1", ws)].length === 0 ? "workspace" : "session";
          return json(
            {
              error: `unknown ${unknown}`,
              hint: unknown === "workspace"
                ? "create one with POST /workspaces first, then mint a session"
                : "mint one with POST /workspaces/:id/sessions first, then retry with that session id",
            },
            !ws ? 400 : 404,
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
        }
        if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
          return json(
            { error: "missing fence", hint: "retry as POST /workspaces/:id/sessions/:sid/claim with JSON {fence, expected}" },
            400,
          );
        }
        const checked = enforceFence(this.readFence(sid), fence, expected);
        if ("status" in checked) return json(checked.body, checked.status);
        this.rotateFence(sid, checked);
        return json({ sessionId: sid, fence: checked.fence, revision: checked.revision });
      }

      if (request.method === "POST" && url.pathname === "/run") {
        const ws = url.searchParams.get("ws") ?? "";
        const sid = url.searchParams.get("sid") ?? "";
        if (!ws) {
          return json(
            { error: "missing workspace", hint: "call POST /workspaces/:id/sessions/:sid/run on the Worker instead" },
            400,
          );
        }
        if ([...sql.exec("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1", ws)].length === 0) {
          return json({ error: "unknown workspace", hint: "create one with POST /workspaces first, then mint a session" }, 404);
        }
        if (!sid || [...sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws)].length === 0) {
          return json(
            { error: "unknown session", hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id" },
            404,
          );
        }
        let prompt: unknown;
        let fence: unknown;
        let expected: unknown;
        let hasFence = false;
        let hasExpected = false;
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
          }
        } catch {
          prompt = undefined;
        }
        if (typeof prompt !== "string" || prompt.length === 0) {
          return json(
            { error: "missing prompt", hint: 'retry as POST /workspaces/:id/sessions/:sid/run with JSON {"prompt": "read seed.txt"}' },
            400,
          );
        }
        return this.enqueueSessionTurn(sid, async () => {
          let rotated: { fence: string; revision: number } | null = null;
          if (hasFence || hasExpected) {
            if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
              return json(
                { error: "missing fence", hint: "retry the run with both {fence, expected}, or omit both for the legacy path" },
                400,
              );
            }
            const checked = enforceFence(this.readFence(sid), fence, expected);
            if ("status" in checked) return json(checked.body, checked.status);
            this.rotateFence(sid, checked);
            rotated = checked;
          }
          const runId = crypto.randomUUID();
          try {
            const session = createAgentSession({ files: this.files, ws, shell, model, tools, apiKey, history: { leaf: sessionLeaf(sql, sid), readEntry: (cursor) => getEntry(sql, sid, cursor) } });
            const turn = await session.run(prompt);
            recordTurnWithOpen(sql, sid, runId, prompt, turn.toolCalls, turn.result, turn.usage, turn.halt ?? null);
            const out = {
              result: turn.result,
              toolCalls: turn.toolCalls,
              runtime: { via: turn.via, model: turn.model },
              usage: turn.usage,
              ...(turn.halt ? { halt: turn.halt } : {}),
            };
            return rotated !== null ? json({ ...out, fence: rotated.fence, revision: rotated.revision }) : json(out);
          } catch (e) {
            openRun(sql, sid, runId);
            if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
              const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry the run";
              return json({ error: e.error, hint }, 500);
            }
            return json({ error: "run failed", hint: "retry the run with a simpler prompt" }, 500);
          }
        });
      }

      if (request.method === "GET" && url.pathname === "/entries") {
        const ws = url.searchParams.get("ws") ?? "";
        const sid = url.searchParams.get("sid") ?? "";
        if (!ws) {
          return json(
            { error: "missing workspace", hint: "retry as GET /workspaces/:id/sessions/:sid/entries on the Worker instead" },
            400,
          );
        }
        if ([...sql.exec("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1", ws)].length === 0) {
          return json(
            { error: "unknown workspace", hint: "create one with POST /workspaces first, then mint a session" },
            404,
          );
        }
        if (!sid || [...sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws)].length === 0) {
          return json(
            { error: "unknown session", hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id" },
            404,
          );
        }
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isInteger(after) || after < 0) {
          return json(
            { error: "bad after", hint: "retry with ?after=N where N is a non-negative cursor, e.g. ?after=0" },
            400,
          );
        }
        const limit = Number(url.searchParams.get("limit") ?? "100");
        if (!Number.isInteger(limit) || limit < 0) {
          return json(
            { error: "bad limit", hint: "retry with ?limit=L where L is a non-negative integer up to 1000, e.g. ?limit=100" },
            400,
          );
        }
        const { count, head } = entryHead(sql, sid);
        return json({ entries: listEntries(sql, sid, { after, limit }), head, count });
      }

      if (request.method === "GET" && url.pathname === "/meta") {
        const ws = url.searchParams.get("ws") ?? "";
        const sid = url.searchParams.get("sid") ?? "";
        if (!ws) {
          return json(
            { error: "missing workspace", hint: "retry as GET /workspaces/:id/sessions/:sid/meta on the Worker instead" },
            400,
          );
        }
        if ([...sql.exec("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1", ws)].length === 0) {
          return json(
            { error: "unknown workspace", hint: "create one with POST /workspaces first, then mint a session" },
            404,
          );
        }
        if (!sid || [...sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws)].length === 0) {
          return json(
            { error: "unknown session", hint: "mint one with POST /workspaces/:id/sessions first, then retry with that session id" },
            404,
          );
        }
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
        return json({
          sid,
          ws,
          created,
          head,
          count,
          openRun,
          usage: withSessionRates(sumResultUsage(sql, sid), null),
        });
      }

      return json(
        { error: "not found", hint: "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files" },
        404,
      );
    }
  };
}
