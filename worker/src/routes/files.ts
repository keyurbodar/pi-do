import { normalizeWorkspacePath } from "pi-cf/tools/tools";
import { FILE_TOO_LARGE_HINT, MAX_FILE_BYTES, err, json, type RouteHandler } from "./_shared";

const create: RouteHandler = async (ctx, request) => {
  if (request.method !== "POST") return null;
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
  ctx.state.storage.sql.exec(
    "INSERT OR IGNORE INTO workspaces(id, created_at) VALUES (?, ?)",
    workspaceId,
    new Date().toISOString(),
  );
  return json({ workspaceId });
};

const exists: RouteHandler = (ctx, request, url) => {
  if (request.method !== "GET") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const bad = ctx.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
  if (bad) return bad;
  return json({ workspaceId: ws, exists: true });
};

const files: RouteHandler = async (ctx, request, url) => {
  const ws = url.searchParams.get("ws") ?? "";
  const bad = ctx.requireSession(ws, null, "call PUT /workspaces/:id/files?path=P on the Worker instead", "create one with POST /workspaces first");
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
    const bytes = ctx.files.put(ws, path, buf, new Date().toISOString());
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
    if (ctx.files.exists(ws, path)) {
      ctx.files.remove(ws, path);
      return json({ removed: [path] });
    }
    const under = ctx.files.list(ws, `${path}/`);
    if (under.length === 0) {
      return err(`no such file: ${path}`, "check the path with files ls first, then retry", 404);
    }
    if (url.searchParams.get("recursive") !== "true") {
      return err(`${path} is a directory`, "retry with ?recursive=true to delete the whole tree, or remove files one by one", 400);
    }
    const removed = ctx.files.removeTree(ws, `${path}/`);
    return json({ removed });
  }

  if (request.method === "GET") {
    if (url.searchParams.has("list")) {
      const dir = url.searchParams.get("list") ?? "";
      const entries = ctx.files.list(ws, dir);
      return json({ entries });
    }
    const path = url.searchParams.get("path");
    if (!path) {
      return err("missing path", "retry as GET /workspaces/:id/files?path=P, or list with ?list=DIR", 400);
    }
    const body = ctx.files.get(ws, path);
    if (body === undefined) {
      return err(`no such file: ${path}`, "upload it with PUT /workspaces/:id/files?path=P first", 404);
    }
    return new Response(body as BodyInit, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  return null;
};

export const fileRoutes: Record<string, RouteHandler> = {
  "/create": create,
  "/exists": exists,
  "/files": files,
};
