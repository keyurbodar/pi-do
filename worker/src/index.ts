import { WorkspaceDO } from "./workspace-do";
import { EXEC_TIMEOUT_MS, ShellWorker } from "./shell-exec";
import { listCatalogModels } from "./model-runtime";

export { WorkspaceDO, ShellWorker };

interface ShellWorkerEntrypoint {
  exec(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    sid?: string;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean; killed: boolean }>;
  kill(input: { sid: string }): Promise<{ killed: boolean }>;
  dispose(input: { sid: string }): Promise<{ disposed: true; stdoutBytes: number; stderrBytes: number }>;
}

interface Env {
  WORKSPACE_DO: DurableObjectNamespace;
  // Service binding pinned to the ShellWorker entrypoint
  // (wrangler.toml [[services]] entrypoint = "ShellWorker").
  SHELL_WORKER: ShellWorkerEntrypoint;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // Buffer client bodies before forwarding: the DO answers early 4xx on
    // several routes without reading the body, and a half-forwarded stream
    // kills the dev server. Bodies here are prompts and small files.
    const rawBody =
      request.method === "POST" || request.method === "PUT"
        ? await request.arrayBuffer()
        : undefined;
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
        { method: "POST", headers: { "content-type": "application/json" }, body: rawBody } as RequestInit,
      );
    }

    // POST /workspaces/:id/sessions/:sid/claim → rotate owner fence via revision CAS
    if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "claim"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/claim");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      } as RequestInit);
    }

    // POST /workspaces/:id/sessions/:sid/model → persist a model switch as a pi entry
    if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "model"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/model");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      } as RequestInit);
    }

    // POST /workspaces/:id/sessions/:sid/thinking → persist a thinking switch as a pi entry
    if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "thinking"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/thinking");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      } as RequestInit);
    }

    // PUT|GET /workspaces/:id/settings → workspace default model triple for session mint
    if (
      (request.method === "PUT" || request.method === "POST" || request.method === "GET") &&
      parts.length === 3 &&
      parts[0] === "workspaces" &&
      parts[2] === "settings"
    ) {
      const workspaceId = parts[1];
      const inner = new URL("http://do/settings");
      inner.searchParams.set("ws", workspaceId);
      const init = request.method === "GET"
        ? { method: "GET" }
        : { method: "PUT", headers: { "content-type": "application/json" }, body: rawBody };
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), init as RequestInit);
    }

    // GET /models[?provider=P] → catalog ids with context windows, no keys needed
    if (
      request.method === "GET" &&
      parts.length === 1 &&
      parts[0] === "models"
    ) {
      const only = url.searchParams.get("provider");
      const models = listCatalogModels().filter((m) => only === null || m.provider === only);
      if (only !== null && models.length === 0) {
        return Response.json(
          {
            error: `unknown provider: ${only}`,
            hint: "retry GET /models without ?provider to list the catalog",
          },
          { status: 404 },
        );
      }
      return Response.json({ models });
    }

    // POST /workspaces/:id/sessions/:sid/run → one headless harness turn
    if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "run"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/run");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      } as RequestInit);
    }

    // POST /workspaces/:id/sessions/:sid/compact → manual compaction (same path as the alarm).
    if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "compact"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/compact");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), { method: "POST" } as RequestInit);
    }

    // GET /workspaces/:id/sessions/:sid/archive → one cold page (?page=N).
    if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "archive"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/archive");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      const page = url.searchParams.get("page");
      if (page !== null) inner.searchParams.set("page", page);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), { method: "GET" } as RequestInit);
    }

    // GET /workspaces/:id/sessions/:sid/entries → ordered replay slice (?after=N&limit=L).
    if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "entries"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/entries");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      const after = url.searchParams.get("after");
      if (after !== null) inner.searchParams.set("after", after);
      const limit = url.searchParams.get("limit");
      if (limit !== null) inner.searchParams.set("limit", limit);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), { method: "GET" } as RequestInit);
    }

    // GET /workspaces/:id/sessions/:sid/meta → resume cursor.
    if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "meta"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/meta");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), { method: "GET" } as RequestInit);
    }

    // PUT|GET|DELETE /workspaces/:id/files
    if (
      (request.method === "PUT" || request.method === "GET" || request.method === "DELETE") &&
      parts.length === 3 &&
      parts[0] === "workspaces" &&
      parts[2] === "files"
    ) {
      const workspaceId = parts[1];
      const inner = new URL("http://do/files");
      inner.searchParams.set("ws", workspaceId);
      for (const [k, v] of url.searchParams) inner.searchParams.set(k, v);
      const init = request.method === "PUT"
        ? { method: "PUT", body: rawBody }
        : request.method === "DELETE"
          ? { method: "DELETE" }
          : { method: "GET" };
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(inner.toString(), init as RequestInit);
    }

    // POST /workspaces/:id/exec → shell via the ShellWorker entrypoint.
    // No sid is the one-off path; with sid the call runs on that exec
    // session so `export` and `cd` persist across calls.
    if (
      request.method === "POST" &&
      parts.length === 3 &&
      parts[0] === "workspaces" &&
      parts[2] === "exec"
    ) {
      const workspaceId = parts[1];
      const probe = await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(`http://do/exists?ws=${encodeURIComponent(workspaceId)}`);
      if (probe.status === 404) {
        return Response.json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first",
          },
          { status: 404 },
        );
      }
      let body: { command?: unknown; cwd?: unknown; env?: unknown; sid?: unknown };
      try {
        body = JSON.parse(new TextDecoder().decode(rawBody)) as typeof body;
      } catch {
        return Response.json(
          {
            error: "missing command",
            hint: 'retry as POST /workspaces/:id/exec with JSON {"command": "echo hi"}',
          },
          { status: 400 },
        );
      }
      if (typeof body?.command !== "string" || body.command.length === 0) {
        return Response.json(
          {
            error: "missing command",
            hint: 'retry as POST /workspaces/:id/exec with JSON {"command": "echo hi"}',
          },
          { status: 400 },
        );
      }
      if (body.cwd !== undefined && typeof body.cwd !== "string") {
        return Response.json(
          {
            error: "bad cwd",
            hint: 'cwd must be a string path, e.g. {"command": "pwd", "cwd": "/workspace"}',
          },
          { status: 400 },
        );
      }
      if (body.sid !== undefined && (typeof body.sid !== "string" || body.sid.length === 0)) {
        return Response.json(
          {
            error: "bad sid",
            hint: 'sid must be a session id string, e.g. {"command": "echo hi", "sid": "exec-1"}',
          },
          { status: 400 },
        );
      }
      let result;
      try {
        result = await env.SHELL_WORKER.exec({
          command: body.command,
          cwd: body.cwd,
          env: body.env as Record<string, string> | undefined,
          sid: body.sid,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("exec busy")) {
          return Response.json(
            {
              error: message,
              hint: "wait for the run to settle, or stop it via POST /workspaces/:id/exec/kill",
            },
            { status: 409 },
          );
        }
        if (message.startsWith("exec sessions full")) {
          return Response.json(
            {
              error: message,
              hint: "drop an idle session via POST /workspaces/:id/exec/dispose, then retry",
            },
            { status: 429 },
          );
        }
        if (message.startsWith("exec cwd escapes")) {
          return Response.json(
            {
              error: message,
              hint: "stay under /workspace, e.g. {\"command\": \"pwd\", \"cwd\": \"/workspace\"}",
            },
            { status: 400 },
          );
        }
        throw e;
      }
      if (result.killed) {
        return Response.json(
          {
            error: "exec killed by kill request",
            hint: "retry the command, or drop the session via POST /workspaces/:id/exec/dispose",
          },
          { status: 408 },
        );
      }
      if (result.timedOut) {
        return Response.json(
          {
            error: `exec timed out after ${EXEC_TIMEOUT_MS}ms`,
            hint: "retry with a shorter command, or stop a live run via POST /workspaces/:id/exec/kill",
          },
          { status: 408 },
        );
      }
      return Response.json({ stdout: result.stdout, stderr: result.stderr, exit: result.exit });
    }

    // POST /workspaces/:id/exec/kill → abort the live run on an exec session.
    if (
      request.method === "POST" &&
      parts.length === 4 &&
      parts[0] === "workspaces" &&
      parts[2] === "exec" &&
      parts[3] === "kill"
    ) {
      const workspaceId = parts[1];
      const probe = await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(`http://do/exists?ws=${encodeURIComponent(workspaceId)}`);
      if (probe.status === 404) {
        return Response.json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first",
          },
          { status: 404 },
        );
      }
      let body: { sid?: unknown };
      try {
        body = JSON.parse(new TextDecoder().decode(rawBody)) as typeof body;
      } catch {
        return Response.json(
          {
            error: "missing sid",
            hint: 'retry as POST /workspaces/:id/exec/kill with JSON {"sid": "exec-1"}',
          },
          { status: 400 },
        );
      }
      if (typeof body?.sid !== "string" || body.sid.length === 0) {
        return Response.json(
          {
            error: "missing sid",
            hint: 'retry as POST /workspaces/:id/exec/kill with JSON {"sid": "exec-1"}',
          },
          { status: 400 },
        );
      }
      try {
        const outcome = await env.SHELL_WORKER.kill({ sid: body.sid });
        return Response.json({ killed: outcome.killed });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("no such exec session")) {
          return Response.json(
            {
              error: message,
              hint: "run one command with that sid first to create the session",
            },
            { status: 404 },
          );
        }
        throw e;
      }
    }

    // POST /workspaces/:id/exec/dispose → drop an exec session and its state.
    if (
      request.method === "POST" &&
      parts.length === 4 &&
      parts[0] === "workspaces" &&
      parts[2] === "exec" &&
      parts[3] === "dispose"
    ) {
      const workspaceId = parts[1];
      const probe = await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(`http://do/exists?ws=${encodeURIComponent(workspaceId)}`);
      if (probe.status === 404) {
        return Response.json(
          {
            error: "unknown workspace",
            hint: "create one with POST /workspaces first",
          },
          { status: 404 },
        );
      }
      let body: { sid?: unknown };
      try {
        body = JSON.parse(new TextDecoder().decode(rawBody)) as typeof body;
      } catch {
        return Response.json(
          {
            error: "missing sid",
            hint: 'retry as POST /workspaces/:id/exec/dispose with JSON {"sid": "exec-1"}',
          },
          { status: 400 },
        );
      }
      if (typeof body?.sid !== "string" || body.sid.length === 0) {
        return Response.json(
          {
            error: "missing sid",
            hint: 'retry as POST /workspaces/:id/exec/dispose with JSON {"sid": "exec-1"}',
          },
          { status: 400 },
        );
      }
      const outcome = await env.SHELL_WORKER.dispose({ sid: body.sid });
      return Response.json({ disposed: outcome.disposed, stdoutBytes: outcome.stdoutBytes, stderrBytes: outcome.stderrBytes });
    }

    // GET /workspaces/:id/sessions/:sid/stream → WS upgrade for live turns.
    if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[0] === "workspaces" &&
      parts[2] === "sessions" &&
      parts[4] === "stream"
    ) {
      const workspaceId = parts[1];
      const sessionId = parts[3];
      const inner = new URL("http://do/stream");
      inner.searchParams.set("ws", workspaceId);
      inner.searchParams.set("sid", sessionId);
      for (const key of ["fence", "expected"]) {
        const value = url.searchParams.get(key);
        if (value !== null) inner.searchParams.set(key, value);
      }
      return await env.WORKSPACE_DO.get(
        env.WORKSPACE_DO.idFromName(workspaceId),
      ).fetch(
        new Request(inner.toString(), { method: "GET", headers: request.headers }),
      );
    }

    return new Response(
      JSON.stringify({
        error: "not found",
        hint: "use POST /workspaces, then POST /workspaces/:id/sessions, then PUT|GET /workspaces/:id/files?path=P or POST /workspaces/:id/sessions/:sid/git or POST /workspaces/:id/sessions/:sid/run",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  },
};
