import { Hono } from "hono";
import { cors } from "hono/cors";
import { vValidator } from "@hono/valibot-validator";
import { WorkspaceDO } from "./workspace-do";
import { EXEC_TIMEOUT_MS, ShellWorker } from "./shell-exec";
import { keyedProviders, listCatalogModels, type RuntimeEnv } from "./model-runtime";
import { bgSchema, claimSchema, execSchema, handleSchema, modelSchema, sidSchema } from "./schemas";

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
  bgStart(input: { command: string; cwd?: string; env?: Record<string, string> }): Promise<{ handle: string }>;
  bgRead(input: { handle: string }): Promise<{ done: boolean; stdout?: string; stderr?: string; exit?: number; timedOut?: boolean; killed?: boolean }>;
  bgKill(input: { handle: string }): Promise<{ killed: boolean }>;
}

interface Env {
  WORKSPACE_DO: DurableObjectNamespace;
  // Service binding pinned to the ShellWorker entrypoint
  // (wrangler.toml [[services]] entrypoint = "ShellWorker").
  SHELL_WORKER: ShellWorkerEntrypoint;
}

type AppEnv = { Bindings: Env };

// Buffer client bodies before forwarding: the DO answers early 4xx on
// several routes without reading the body, and a half-forwarded stream
// kills the dev server. Bodies here are prompts and small files.
async function bufferedBody(req: { method: string; arrayBuffer: () => Promise<ArrayBuffer> }): Promise<ArrayBuffer | undefined> {
  const method = req.method;
  if (method === "POST" || method === "PUT") return await req.arrayBuffer();
  return undefined;
}

function doStub(env: Env, workspaceId: string): DurableObjectStub {
  return env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
}

async function probeWorkspace(env: Env, workspaceId: string): Promise<boolean> {
  const probe = await doStub(env, workspaceId).fetch(
    `http://do/exists?ws=${encodeURIComponent(workspaceId)}`,
  );
  return probe.status !== 404;
}

function unknownWorkspace() {
  return Response.json(
    {
      error: "unknown workspace",
      hint: "create one with POST /workspaces first",
    },
    { status: 404 },
  );
}

function firstIssueKey(result: { issues?: Array<{ path?: Array<{ key?: unknown }> | null }> }): string | null {
  const path = result.issues?.[0]?.path;
  if (!path) return null;
  for (const segment of path) {
    if (segment && typeof segment.key === "string") return segment.key;
  }
  return null;
}

// Route registration is chained so the export below carries the full
// schema: hono types each link into the next, and typeof app is the hc
// client contract. Runtime behavior is statement-order identical.
const app = new Hono<AppEnv>()
  .use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }))

  // GET / → health (doctor probe)
  .get("/", (c) => Response.json({ ok: true, service: "pi-do" }))

  // POST /workspaces → mint a workspace
  .post("/workspaces", async (c) => {
    const workspaceId = crypto.randomUUID();
    const stub = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId));
    return await stub.fetch("http://do/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
  })
  // POST /workspaces/:id/sessions → mint a session (one row; lifecycle in PR07)
  .post("/workspaces/:id/sessions", async (c) => {
    const workspaceId = c.req.param("id");
    const inner = new URL("http://do/sessions");
    inner.searchParams.set("ws", workspaceId);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), {
      method: c.req.method,
      headers: { "content-type": "application/json" },
      body: await bufferedBody(c.req),
    } as RequestInit);
  })

  // POST /workspaces/:id/sessions/:sid/git → narrow argv git (allowlist first)
  .post("/workspaces/:id/sessions/:sid/git", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/git");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    return await doStub(c.env, workspaceId).fetch(
      inner.toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body: await bufferedBody(c.req) } as RequestInit,
    );
  })

  // POST /workspaces/:id/sessions/:sid/claim → rotate owner fence via revision CAS
  .post(
    "/workspaces/:id/sessions/:sid/claim",
    vValidator("json", claimSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "missing fence",
            hint: "retry as POST /workspaces/:id/sessions/:sid/claim with JSON {fence, expected}",
          },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/claim");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await bufferedBody(c.req),
    } as RequestInit);
    },
  )

  // POST /workspaces/:id/sessions/:sid/model → persist a model switch as a pi entry
  .post(
    "/workspaces/:id/sessions/:sid/model",
    vValidator("json", modelSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "missing model",
            hint: 'retry with JSON {"provider", "id"} or {} for the keyed default',
          },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/model");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await bufferedBody(c.req),
    } as RequestInit);
    },
  )

  // POST /workspaces/:id/sessions/:sid/thinking → persist a thinking switch as a pi entry
  .post("/workspaces/:id/sessions/:sid/thinking", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/thinking");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await bufferedBody(c.req),
    } as RequestInit);
  })

  // PUT|POST|GET /workspaces/:id/settings → workspace default model triple for session mint
  .on(["PUT", "POST", "GET"], "/workspaces/:id/settings", async (c) => {
    const workspaceId = c.req.param("id");
    const inner = new URL("http://do/settings");
    inner.searchParams.set("ws", workspaceId);
    const init =
      c.req.method === "GET"
        ? { method: "GET" }
        : { method: "PUT", headers: { "content-type": "application/json" }, body: await bufferedBody(c.req) };
    return await doStub(c.env, workspaceId).fetch(inner.toString(), init as RequestInit);
  })

  // GET /models[?provider=P] → catalog ids with context windows, no keys needed
  .get("/models", (c) => {
    const only = c.req.query("provider") ?? null;
    const models = listCatalogModels().filter((m) => only === null || m.provider === only);
    if (only !== null && models.length === 0) {
      return c.json(
        {
          error: `unknown provider: ${only}`,
          hint: "retry GET /models without ?provider to list the catalog",
        },
        404,
      );
    }
    const keyed = keyedProviders(c.env as unknown as RuntimeEnv).map((provider) => provider.id);
    return c.json({ models, keyed });
  })

  // POST /workspaces/:id/sessions/:sid/run → one headless harness turn
  .post("/workspaces/:id/sessions/:sid/run", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/run");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await bufferedBody(c.req),
    } as RequestInit);
  })

  // POST /workspaces/:id/sessions/:sid/compact → manual compaction (same path as the alarm).
  .post("/workspaces/:id/sessions/:sid/compact", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/compact");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), { method: "POST" } as RequestInit);
  })

  // GET /workspaces/:id/sessions/:sid/archive → one cold page (?page=N).
  .get("/workspaces/:id/sessions/:sid/archive", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/archive");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    const page = c.req.query("page");
    if (page !== undefined) inner.searchParams.set("page", page);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), { method: "GET" } as RequestInit);
  })

  // GET /workspaces/:id/sessions/:sid/entries → ordered replay slice (?after=N&limit=L).
  .get("/workspaces/:id/sessions/:sid/entries", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/entries");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    const after = c.req.query("after");
    if (after !== undefined) inner.searchParams.set("after", after);
    const limit = c.req.query("limit");
    if (limit !== undefined) inner.searchParams.set("limit", limit);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), { method: "GET" } as RequestInit);
  })

  // GET /workspaces/:id/sessions/:sid/meta → resume cursor.
  .get("/workspaces/:id/sessions/:sid/meta", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/meta");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    return await doStub(c.env, workspaceId).fetch(inner.toString(), { method: "GET" } as RequestInit);
  })

  // PUT|GET|DELETE /workspaces/:id/files
  .on(["PUT", "GET", "DELETE"], "/workspaces/:id/files", async (c) => {
    const workspaceId = c.req.param("id");
    const inner = new URL("http://do/files");
    inner.searchParams.set("ws", workspaceId);
    const raw = new URL(c.req.url);
    for (const [k, v] of raw.searchParams) inner.searchParams.set(k, v);
    const init =
      c.req.method === "PUT"
        ? { method: "PUT", body: await bufferedBody(c.req) }
        : c.req.method === "DELETE"
          ? { method: "DELETE" }
          : { method: "GET" };
    return await doStub(c.env, workspaceId).fetch(inner.toString(), init as RequestInit);
  })

  // ---- Validated shell routes: valibot schemas, legacy error bodies preserved ----

  // POST /workspaces/:id/exec → shell via the ShellWorker entrypoint.
  // No sid is the one-off path; with sid the call runs on that exec
  // session so `export` and `cd` persist across calls.
  .post(
    "/workspaces/:id/exec",
    vValidator("json", execSchema, (result, c) => {
      if (!result.success) {
        const key = firstIssueKey(result as unknown as Parameters<typeof firstIssueKey>[0]);
        if (key === "cwd") {
          return c.json(
            {
              error: "bad cwd",
              hint: 'cwd must be a string path, e.g. {"command": "pwd", "cwd": "/workspace"}',
            },
            400,
          );
        }
        if (key === "sid") {
          return c.json(
            {
              error: "bad sid",
              hint: 'sid must be a session id string, e.g. {"command": "echo hi", "sid": "exec-1"}',
            },
            { status: 400 },
          );
        }
        return c.json(
          {
            error: "missing command",
            hint: 'retry as POST /workspaces/:id/exec with JSON {"command": "echo hi"}',
          },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
      const workspaceId = c.req.param("id");
      if (!(await probeWorkspace(c.env, workspaceId))) return unknownWorkspace();
      const body = c.req.valid("json");
      let result;
      try {
        result = await c.env.SHELL_WORKER.exec({
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
    },
  )

  // POST /workspaces/:id/exec/kill → abort the live run on an exec session.
  .post(
    "/workspaces/:id/exec/kill",
    vValidator("json", sidSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "missing sid",
            hint: 'retry as POST /workspaces/:id/exec/kill with JSON {"sid": "exec-1"}',
          },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
      const workspaceId = c.req.param("id");
      if (!(await probeWorkspace(c.env, workspaceId))) return unknownWorkspace();
      const body = c.req.valid("json");
      try {
        const outcome = await c.env.SHELL_WORKER.kill({ sid: body.sid });
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
    },
  )

  // POST /workspaces/:id/exec/dispose → drop an exec session and its state.
  .post(
    "/workspaces/:id/exec/dispose",
    vValidator("json", sidSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "missing sid",
            hint: 'retry as POST /workspaces/:id/exec/dispose with JSON {"sid": "exec-1"}',
          },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
      const workspaceId = c.req.param("id");
      if (!(await probeWorkspace(c.env, workspaceId))) return unknownWorkspace();
      const body = c.req.valid("json");
      const outcome = await c.env.SHELL_WORKER.dispose({ sid: body.sid });
      return Response.json({ disposed: outcome.disposed, stdoutBytes: outcome.stdoutBytes, stderrBytes: outcome.stderrBytes });
    },
  )

  .post(
    "/workspaces/:id/bg",
    vValidator("json", bgSchema, (result, c) => {
      if (!result.success) {
        const key = firstIssueKey(result as unknown as Parameters<typeof firstIssueKey>[0]);
        if (key === "cwd") {
          return c.json(
            {
              error: "bad cwd",
              hint: 'cwd must be a string path, e.g. {"command": "pwd", "cwd": "/workspace"}',
            },
            400,
          );
        }
        return c.json(
          {
            error: "missing command",
            hint: 'retry as POST /workspaces/:id/bg with JSON {"command": "sleep 30"}',
          },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
      const workspaceId = c.req.param("id");
      if (!(await probeWorkspace(c.env, workspaceId))) return unknownWorkspace();
      const body = c.req.valid("json");
      try {
        const outcome = await c.env.SHELL_WORKER.bgStart({
          command: body.command,
          cwd: body.cwd,
          env: body.env as Record<string, string> | undefined,
        });
        return Response.json({ handle: outcome.handle });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("exec cwd escapes")) {
          return Response.json(
            {
              error: message,
              hint: "stay under /workspace, e.g. {\"command\": \"pwd\", \"cwd\": \"/workspace\"}",
            },
            { status: 400 },
          );
        }
        if (message.startsWith("bg processes full")) {
          return Response.json(
            {
              error: message,
              hint: "kill a running process via POST /workspaces/:id/bg/kill, then retry",
            },
            { status: 429 },
          );
        }
        throw e;
      }
    },
  )

  .get("/workspaces/:id/bg", async (c) => {
    const workspaceId = c.req.param("id");
    if (!(await probeWorkspace(c.env, workspaceId))) return unknownWorkspace();
    const handle = c.req.query("handle");
    if (handle === null || handle === undefined || handle.length === 0) {
      return Response.json(
        {
          error: "missing handle",
          hint: "retry as GET /workspaces/:id/bg?handle=H with the handle from POST /workspaces/:id/bg",
        },
        { status: 400 },
      );
    }
    try {
      const result = await c.env.SHELL_WORKER.bgRead({ handle });
      return Response.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("no such bg process")) {
        return Response.json(
          {
            error: message,
            hint: "start one with POST /workspaces/:id/bg first, or it was killed",
          },
          { status: 404 },
        );
      }
      throw e;
    }
  })

  .post(
    "/workspaces/:id/bg/kill",
    vValidator("json", handleSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "missing handle",
            hint: 'retry as POST /workspaces/:id/bg/kill with JSON {"handle": "bg-..."}',
          },
          400,
        );
      }
      return undefined;
    }),
    async (c) => {
      const workspaceId = c.req.param("id");
      if (!(await probeWorkspace(c.env, workspaceId))) return unknownWorkspace();
      const body = c.req.valid("json");
      try {
        const outcome = await c.env.SHELL_WORKER.bgKill({ handle: body.handle });
        return Response.json({ killed: outcome.killed });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("no such bg process")) {
          return Response.json(
            {
              error: message,
              hint: "start one with POST /workspaces/:id/bg first, or it was killed",
            },
            { status: 404 },
          );
        }
        throw e;
      }
    },
  )

  // GET /workspaces/:id/sessions/:sid/stream → WS upgrade for live turns.
  .get("/workspaces/:id/sessions/:sid/stream", async (c) => {
    const workspaceId = c.req.param("id");
    const sessionId = c.req.param("sid");
    const inner = new URL("http://do/stream");
    inner.searchParams.set("ws", workspaceId);
    inner.searchParams.set("sid", sessionId);
    const raw = new URL(c.req.url);
    for (const key of ["fence", "expected"]) {
      const value = raw.searchParams.get(key);
      if (value !== null) inner.searchParams.set(key, value);
    }
    return await doStub(c.env, workspaceId).fetch(
      new Request(inner.toString(), { method: "GET", headers: c.req.raw.headers }),
    );
  })

  .notFound((c) =>
    c.json(
      {
        error: "not found",
        hint: "use POST /workspaces, then POST /workspaces/:id/sessions, then PUT|GET /workspaces/:id/files?path=P or POST /workspaces/:id/sessions/:sid/git or POST /workspaces/:id/sessions/:sid/run",
      },
      404,
    ),
  );

export type AppType = typeof app;

export default app;
