import { createFileStore, type FileStore } from "./files";

import type { DurableObjectState } from "@cloudflare/workers-types";

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
    sql.exec(
      "CREATE TABLE IF NOT EXISTS pi_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT, sid TEXT, cursor INTEGER, type TEXT, body TEXT)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS pi_owners(sid TEXT PRIMARY KEY, fence TEXT, rev INTEGER)",
    );
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

    return json(
      { error: "not found", hint: "use POST /workspaces or /workspaces/:id/files" },
      404,
    );
  }
}
