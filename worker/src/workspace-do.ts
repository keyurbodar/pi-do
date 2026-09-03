import type { DurableObjectState } from "@cloudflare/workers-types";
import { createWorkspaceFs, hasGitDir } from "./git-fs";
import { gateArgv, notARepoBody, NotARepoError, runGitRead } from "./git-reads";

interface Env {
  WORKSPACE_DO: DurableObjectNamespace;
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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private ensureSchema(): void {
    const sql = this.state.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, created_at TEXT)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS files(ws TEXT, path TEXT, body BLOB, updated_at TEXT, PRIMARY KEY(ws, path))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS pi_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT, sid TEXT, cursor INTEGER, type TEXT, body TEXT)",
    );
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
        this.state.storage.sql.exec(
          "INSERT OR REPLACE INTO files(ws, path, body, updated_at) VALUES (?, ?, ?, ?)",
          ws,
          path,
          buf,
          new Date().toISOString(),
        );
        return json({ path, bytes: buf.byteLength });
      }

      if (request.method === "GET") {
        if (url.searchParams.has("list")) {
          const dir = url.searchParams.get("list") ?? "";
          const rows = [
            ...this.state.storage.sql.exec(
              "SELECT path, length(body) AS bytes FROM files WHERE ws = ? AND path LIKE (? || '%') ORDER BY path",
              ws,
              dir,
            ),
          ] as unknown as Array<{ path: string; bytes: number }>;
          return json({
            entries: rows.map((r) => ({ path: r.path, bytes: r.bytes })),
          });
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
        const rows = [
          ...this.state.storage.sql.exec(
            "SELECT body FROM files WHERE ws = ? AND path = ?",
            ws,
            path,
          ),
        ] as unknown as Array<{ body: ArrayBuffer }>;
        if (rows.length === 0) {
          return json(
            {
              error: `no such file: ${path}`,
              hint: "upload it with PUT /workspaces/:id/files?path=P first",
            },
            404,
          );
        }
        return new Response(rows[0].body as BodyInit, {
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

    return json(
      { error: "not found", hint: "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files" },
      404,
    );
  }
}
