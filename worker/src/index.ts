import { Hono } from "hono";
import { cors } from "hono/cors";
import { WorkspaceDO } from "./workspace-do";
import { EXEC_TIMEOUT_MS, ShellWorker } from "./shell-exec";
import { keyedProviders, listCatalogModels, type RuntimeEnv } from "./model-runtime";
import { bgSchema, execSchema, handleSchema, sidSchema, vRoute } from "./schemas";

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
  SHELL_WORKER: ShellWorkerEntrypoint;
}

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
type ForwardRequest = { method: string; url: string; header(name: string): string | undefined; arrayBuffer(): Promise<ArrayBuffer> };
async function forward(env: Env, workspaceId: string, path: string, req: ForwardRequest, query: Record<string, string | undefined> = {}): Promise<Response> {
  const inner = new URL(path, "http://do");
  inner.searchParams.set("ws", workspaceId);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) inner.searchParams.set(key, value);
  const stub = doStub(env, workspaceId);
  const body = await bufferedBody(req);
  if (body === undefined) return stub.fetch(inner.toString(), { method: req.method });
  return stub.fetch(inner.toString(), { method: req.method, headers: { "content-type": req.header("content-type") ?? "application/json" }, body });
}

async function probeWorkspace(env: Env, workspaceId: string): Promise<boolean> {
  const probe = await doStub(env, workspaceId).fetch(`http://do/exists?ws=${encodeURIComponent(workspaceId)}`);
  return probe.status !== 404;
}

function err(error: string, hint: string, status: number): Response {
  return Response.json({ error, hint }, { status });
}

function unknownWorkspace() {
  return err("unknown workspace", "create one with POST /workspaces first", 404);
}

const app = new Hono<{ Bindings: Env }>()
  .use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }))

  .get("/", (c) => Response.json({ ok: true, service: "pi-do" }))

  .post("/workspaces", async (c) => {
    const workspaceId = crypto.randomUUID();
    const stub = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId));
    return stub.fetch("http://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
  })
  .post("/workspaces/:id/sessions", (c) => forward(c.env, c.req.param("id"), "/sessions", c.req))
  .post("/workspaces/:id/sessions/:sid/git", (c) => forward(c.env, c.req.param("id"), "/git", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/claim", (c) => forward(c.env, c.req.param("id"), "/claim", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/model", (c) => forward(c.env, c.req.param("id"), "/model", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/thinking", (c) => forward(c.env, c.req.param("id"), "/thinking", c.req, { sid: c.req.param("sid") }))
  .on(["PUT", "GET"], "/workspaces/:id/settings", (c) => forward(c.env, c.req.param("id"), "/settings", c.req))

  .get("/models", (c) => {
    const only = c.req.query("provider") ?? null;
    const models = listCatalogModels().filter((m) => only === null || m.provider === only);
    if (only !== null && models.length === 0) {
      return err(`unknown provider: ${only}`, "retry GET /models without ?provider to list the catalog", 404);
    }
    const keyed = keyedProviders(c.env as unknown as RuntimeEnv).map((provider) => provider.id);
    return c.json({ models, keyed });
  })

  .post("/workspaces/:id/sessions/:sid/run", (c) => forward(c.env, c.req.param("id"), "/run", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/compact", (c) => forward(c.env, c.req.param("id"), "/compact", c.req, { sid: c.req.param("sid") }))
  .get("/workspaces/:id/sessions/:sid/archive", (c) => forward(c.env, c.req.param("id"), "/archive", c.req, { sid: c.req.param("sid"), page: c.req.query("page") }))
  .get("/workspaces/:id/sessions/:sid/entries", (c) => forward(c.env, c.req.param("id"), "/entries", c.req, { sid: c.req.param("sid"), after: c.req.query("after"), limit: c.req.query("limit") }))
  .get("/workspaces/:id/sessions/:sid/meta", (c) => forward(c.env, c.req.param("id"), "/meta", c.req, { sid: c.req.param("sid") }))
  .on(["PUT", "GET", "DELETE"], "/workspaces/:id/files", (c) => forward(c.env, c.req.param("id"), "/files", c.req, Object.fromEntries(new URL(c.req.url).searchParams)))

  .post(
    "/workspaces/:id/exec",
    vRoute("exec", execSchema),
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
          return err(message, "wait for the run to settle, or stop it via POST /workspaces/:id/exec/kill", 409);
        }
        if (message.startsWith("exec sessions full")) {
          return err(message, "drop an idle session via POST /workspaces/:id/exec/dispose, then retry", 429);
        }
        if (message.startsWith("exec cwd escapes")) {
          return err(message, 'stay under /workspace, e.g. {"command": "pwd", "cwd": "/workspace"}', 400);
        }
        throw e;
      }
      if (result.killed) {
        return err("exec killed by kill request", "retry the command, or drop the session via POST /workspaces/:id/exec/dispose", 408);
      }
      if (result.timedOut) {
        return err(`exec timed out after ${EXEC_TIMEOUT_MS}ms`, "retry with a shorter command, or stop a live run via POST /workspaces/:id/exec/kill", 408);
      }
      return Response.json({ stdout: result.stdout, stderr: result.stderr, exit: result.exit });
    },
  )

  .post(
    "/workspaces/:id/exec/kill",
    vRoute("execKill", sidSchema),
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
          return err(message, "run one command with that sid first to create the session", 404);
        }
        throw e;
      }
    },
  )

  .post(
    "/workspaces/:id/exec/dispose",
    vRoute("execDispose", sidSchema),
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
    vRoute("bg", bgSchema),
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
          return err(message, 'stay under /workspace, e.g. {"command": "pwd", "cwd": "/workspace"}', 400);
        }
        if (message.startsWith("bg processes full")) {
          return err(message, "kill a running process via POST /workspaces/:id/bg/kill, then retry", 429);
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
      return err("missing handle", "retry as GET /workspaces/:id/bg?handle=H with the handle from POST /workspaces/:id/bg", 400);
    }
    try {
      const result = await c.env.SHELL_WORKER.bgRead({ handle });
      return Response.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("no such bg process")) {
        return err(message, "start one with POST /workspaces/:id/bg first, or it was killed", 404);
      }
      throw e;
    }
  })

  .post(
    "/workspaces/:id/bg/kill",
    vRoute("bgKill", handleSchema),
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
          return err(message, "start one with POST /workspaces/:id/bg first, or it was killed", 404);
        }
        throw e;
      }
    },
  )

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

  .notFound(() => err("not found", "check the path and method, then retry", 404));

export type AppType = typeof app;

export default app;
