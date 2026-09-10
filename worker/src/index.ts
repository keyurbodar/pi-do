import { Hono } from "hono";
import { cors } from "hono/cors";
import { ShellWorker } from "./shell-exec";
import { createWorkspace, forwardStream, forwardToWorkspace, WorkspaceDO, type ForwardEnv } from "./workspace-do";
import { keyedProviders, listCatalogModels, type RuntimeEnv } from "./model-runtime";

export { WorkspaceDO, ShellWorker };

interface Env extends ForwardEnv {}

const app = new Hono<{ Bindings: Env }>()
  .use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }))
  .get("/", (c) => Response.json({ ok: true, service: "pi-do" }))
  .post("/workspaces", (c) => createWorkspace(c.env))
  .post("/workspaces/:id/sessions", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/sessions", c.req))
  .post("/workspaces/:id/sessions/:sid/git", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/git", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/claim", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/claim", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/model", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/model", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/thinking", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/thinking", c.req, { sid: c.req.param("sid") }))
  .on(["PUT", "GET"], "/workspaces/:id/settings", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/settings", c.req))
  .post("/workspaces/:id/sessions/:sid/run", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/run", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/compact", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/compact", c.req, { sid: c.req.param("sid") }))
  .get("/workspaces/:id/sessions/:sid/archive", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/archive", c.req, { sid: c.req.param("sid"), page: c.req.query("page") }))
  .get("/workspaces/:id/sessions/:sid/entries", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/entries", c.req, { sid: c.req.param("sid"), after: c.req.query("after"), limit: c.req.query("limit") }))
  .get("/workspaces/:id/sessions/:sid/meta", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/meta", c.req, { sid: c.req.param("sid") }))
  .get("/workspaces/:id/doctor", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/doctor", c.req))
  .post("/workspaces/:id/sessions/:sid/fork", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/fork", c.req, { sid: c.req.param("sid") }))
  .post("/workspaces/:id/sessions/:sid/clone", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/clone", c.req, { sid: c.req.param("sid") }))
  .get("/models", (c) => {
  const only = c.req.query("provider") ?? null;
  const found = listCatalogModels().filter((m) => only === null || m.provider === only);
    if (only !== null && found.length === 0) {
      return Response.json({ error: `unknown provider: ${only}`, hint: "retry GET /models without ?provider to list the catalog" }, { status: 404 });
    }
    const keyed = keyedProviders(c.env as unknown as RuntimeEnv).map((provider) => provider.id);
    return Response.json({ models: found, keyed });
  })
  .on(["PUT", "GET", "DELETE"], "/workspaces/:id/files", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/files", c.req, Object.fromEntries(new URL(c.req.url).searchParams)))
  .post("/workspaces/:id/exec", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/exec", c.req))
  .post("/workspaces/:id/exec/kill", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/exec/kill", c.req))
  .post("/workspaces/:id/exec/dispose", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/exec/dispose", c.req))
  .post("/workspaces/:id/bg", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/bg", c.req))
  .get("/workspaces/:id/bg", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/bg", c.req, { handle: c.req.query("handle") }))
  .post("/workspaces/:id/bg/kill", (c) => forwardToWorkspace(c.env, c.req.param("id"), "/bg/kill", c.req))
  .get("/workspaces/:id/sessions/:sid/stream", (c) => forwardStream(c.env, c.req.param("id"), c.req.param("sid"), c.req))
  .notFound(() => Response.json({ error: "not found", hint: "check the path and method, then retry" }, { status: 404 }));

export type AppType = typeof app;

export default app;
