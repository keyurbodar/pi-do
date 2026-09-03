import { WorkspaceDO } from "./workspace-do";

export { WorkspaceDO };

interface Env {
  WORKSPACE_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // GET / → health (doctor probe)
    if (request.method === "GET" && parts.length === 0) {
      return Response.json({ ok: true, service: "pi-do" });
    }

    // POST /workspaces → mint a workspace
    if (request.method === "POST" && parts.length === 1 && parts[0] === "workspaces") {
      const workspaceId = crypto.randomUUID();
      const stub = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
      return await stub.fetch("http://do/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
    }

    // POST /workspaces/:id/sessions → mint a session (one row; lifecycle in PR07)
    if (
      request.method === "POST" &&
      parts.length === 3 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions"
    ) {
      const workspaceId = parts[1];
      const inner = new URL("http://do/sessions");
      inner.searchParams.set("ws", workspaceId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), { method: "POST" });
    }

    // POST /workspaces/:id/sessions/:sid/git → narrow argv git (allowlist first)
    if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "git"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/git");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(
        inner.toString(),
        { method: "POST", headers: { "content-type": "application/json" }, body: request.body, duplex: "half" } as RequestInit,
      );
    }

    // PUT|GET /workspaces/:id/files
    if (
      (request.method === "PUT" || request.method === "GET") &&
      parts.length === 3 &&
      parts[0] === "workspaces" &&
      parts[2] === "files"
    ) {
      const workspaceId = parts[1];
      const inner = new URL("http://do/files");
      inner.searchParams.set("ws", workspaceId);
      for (const [k, v] of url.searchParams) inner.searchParams.set(k, v);
      const init = request.method === "PUT"
        ? { method: "PUT", body: request.body, duplex: "half" }
        : { method: "GET" };
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), init as RequestInit);
    }

    return new Response(
      JSON.stringify({
        error: "not found",
        hint: "use POST /workspaces, then POST /workspaces/:id/sessions, then PUT|GET /workspaces/:id/files?path=P or POST /workspaces/:id/sessions/:sid/git",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  },
};
