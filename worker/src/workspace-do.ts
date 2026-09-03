import { createFileStore, type FileStore } from "./files";
import { ensureEntriesSchema, listEntries, openRun, recordTurn } from "./entries";
import { ComputerExecutionEnv } from "../../packages/pi-cf/src/env";
import { runHeadlessTurn } from "./harness";
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
    sql.exec(
      "CREATE TABLE IF NOT EXISTS pi_owners(sid TEXT PRIMARY KEY, fence TEXT, rev INTEGER)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, ws TEXT, created_at TEXT)",
    );
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
      this.state.storage.sql.exec("INSERT INTO sessions(sid, ws, created_at) VALUES (?, ?, ?)", sessionId, ws, new Date().toISOString());
      return json({ sessionId });
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
      try {
        const body: unknown = await request.json();
        if (body !== null && typeof body === "object" && "prompt" in body) {
          prompt = body.prompt;
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
      const sql = this.state.storage.sql;
      const runId = crypto.randomUUID();
      openRun(sql, sid, runId);
      try {
        const env = new ComputerExecutionEnv(this.files, ws, this.env.SHELL_WORKER);
        const turn = await runHeadlessTurn(prompt, env);
        recordTurn(sql, sid, runId, prompt, turn.toolCalls, turn.result);
        return json({ result: turn.result, toolCalls: turn.toolCalls });
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

    // GET /entries?ws=&sid=&after=N — raw ordered replay slice.
    // Pagination, metadata, and resume semantics stay in PR09.
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
      return json({ entries: listEntries(this.state.storage.sql, sid, after) });
    }

    return json(
      { error: "not found", hint: "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files" },
      404,
    );
  }
}
