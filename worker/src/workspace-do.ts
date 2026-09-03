import { createFileStore, type FileStore } from "./files";
import { ensureEntriesSchema, entryHead, listEntries, openRun, recordTurn } from "./entries";
import { enforceFence } from "./fence";
import { handleStream } from "./stream";
import { createAgentSession } from "../../packages/pi-cf/src/session";
import { normalizeWorkspacePath } from "../../packages/pi-cf/src/tools";
import { buildRuntime, type RuntimeEnv } from "./model-runtime";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { createWorkspaceFs, hasGitDir } from "./git-fs";
import { gateArgv, notARepoBody, NotARepoError, runGitRead } from "./git-reads";
interface ShellWorkerBinding {
  exec(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean }>;
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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.files = createFileStore(state.storage.sql);
  }

  private ensureSchema(): void {
    const sql = this.state.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, created_at TEXT)",
    );
    this.files.ensureSchema();
    ensureEntriesSchema(sql);
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
        for (const entry of under) this.files.remove(ws, entry.path);
        return json({ removed: under.map((entry) => entry.path) });
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
      this.state.storage.sql.exec(
        "INSERT INTO sessions(sid, ws, created_at, ownerFence, revision) VALUES (?, ?, ?, ?, 0)",
        sessionId,
        ws,
        new Date().toISOString(),
        fence,
      );
      return json({ sessionId, fence, revision: 0 });
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
          {
            error: "missing prompt",
            hint: 'retry as POST /workspaces/:id/sessions/:sid/run with JSON {"prompt": "read seed.txt"}',
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
      openRun(sql, sid, runId);
      try {
        const runtime = buildRuntime(this.env as unknown as RuntimeEnv);
        const session = createAgentSession({
          files: this.files,
          ws,
          shell: this.env.SHELL_WORKER,
          model: runtime.model,
        });
        const turn = await session.run(prompt);
        recordTurn(sql, sid, runId, prompt, turn.toolCalls, turn.result);
        if (rotated !== null) {
          return json({
            result: turn.result,
            toolCalls: turn.toolCalls,
            runtime: { via: turn.via, model: turn.model },
            fence: rotated.fence,
            revision: rotated.revision,
          });
        }
        return json({
          result: turn.result,
          toolCalls: turn.toolCalls,
          runtime: { via: turn.via, model: turn.model },
        });
      } catch (e) {
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
    }

    // GET /stream?ws=&sid= — WS upgrade for live turns (see stream.ts).
    if (url.pathname === "/stream") {
      const ws = url.searchParams.get("ws") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      return handleStream(request, {
        sql: this.state.storage.sql,
        ws,
        sid,
        files: this.files,
        shell: this.env.SHELL_WORKER,
        runtimeEnv: this.env as unknown as RuntimeEnv,
        workspaceKnown: ws !== "" && this.workspaceExists(ws),
        sessionKnown: ws !== "" && sid !== "" && this.sessionExists(ws, sid),
        readFence: () => this.readFence(sid),
        casRotateFence: (oldFence, oldRevision, next) => this.casRotateFence(sid, oldFence, oldRevision, next),
      });
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
      return json({ sid, ws, created, head, count, openRun });
    }

    return json(
      { error: "not found", hint: "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files" },
      404,
    );
  }
}
