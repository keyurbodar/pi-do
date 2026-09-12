import { Hono } from "hono";
import { cors } from "hono/cors";
import { ShellWorker } from "./shell-exec";
import { createWorkspace, forwardStream, forwardToWorkspace, WorkspaceDO, type ForwardEnv } from "./workspace-do";
import { keyedProviders, listCatalogModels, type RuntimeEnv } from "./model-runtime";
import { ROUTE, forwardQuery } from "./routes/table";

export { WorkspaceDO, ShellWorker };

interface Env extends ForwardEnv {}

const app = new Hono<{ Bindings: Env }>()
  .use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }))
  .get("/", (c) => Response.json({ ok: true, service: "pi-do" }))
  .post("/workspaces", (c) => createWorkspace(c.env))
  .post(ROUTE.sessions.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.sessions.inner, c.req))
  .post(ROUTE.git.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.git.inner, c.req, forwardQuery(ROUTE.git, { sid: c.req.param("sid") })))
  .post(ROUTE.claim.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.claim.inner, c.req, forwardQuery(ROUTE.claim, { sid: c.req.param("sid") })))
  .post(ROUTE.model.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.model.inner, c.req, forwardQuery(ROUTE.model, { sid: c.req.param("sid") })))
  .post(ROUTE.thinking.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.thinking.inner, c.req, forwardQuery(ROUTE.thinking, { sid: c.req.param("sid") })))
  .on([...ROUTE.settings.methods], ROUTE.settings.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.settings.inner, c.req))
  .post(ROUTE.run.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.run.inner, c.req, forwardQuery(ROUTE.run, { sid: c.req.param("sid") })))
  .post(ROUTE.compact.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.compact.inner, c.req, forwardQuery(ROUTE.compact, { sid: c.req.param("sid") })))
  .get(ROUTE.archive.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.archive.inner, c.req, forwardQuery(ROUTE.archive, { sid: c.req.param("sid"), get: (k) => c.req.query(k) ?? undefined })))
  .get(ROUTE.entries.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.entries.inner, c.req, forwardQuery(ROUTE.entries, { sid: c.req.param("sid"), get: (k) => c.req.query(k) ?? undefined })))
  .get(ROUTE.meta.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.meta.inner, c.req, forwardQuery(ROUTE.meta, { sid: c.req.param("sid"), get: (k) => c.req.query(k) ?? undefined })))
  .get(ROUTE.snapshot.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.snapshot.inner, c.req, forwardQuery(ROUTE.snapshot, { sid: c.req.param("sid"), get: (k) => c.req.query(k) ?? undefined })))
  .get(ROUTE.doctor.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.doctor.inner, c.req))
  .post(ROUTE.fork.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.fork.inner, c.req, forwardQuery(ROUTE.fork, { sid: c.req.param("sid") })))
  .post(ROUTE.clone.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.clone.inner, c.req, forwardQuery(ROUTE.clone, { sid: c.req.param("sid") })))
  .on([...ROUTE.checkpoints.methods], ROUTE.checkpoints.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.checkpoints.inner, c.req, forwardQuery(ROUTE.checkpoints, { sid: c.req.param("sid") })))
  .post(ROUTE.rewind.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.rewind.inner, c.req, forwardQuery(ROUTE.rewind, { sid: c.req.param("sid") })))
  .get("/models", (c) => {
  const only = c.req.query("provider") ?? null;
  const found = listCatalogModels().filter((m) => only === null || m.provider === only);
    if (only !== null && found.length === 0) {
      return Response.json({ error: `unknown provider: ${only}`, hint: "retry GET /models without ?provider to list the catalog" }, { status: 404 });
    }
    const keyed = keyedProviders(c.env as unknown as RuntimeEnv).map((provider) => provider.id);
    return Response.json({ models: found, keyed });
  })
  .on([...ROUTE.files.methods], ROUTE.files.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.files.inner, c.req, forwardQuery(ROUTE.files, { extra: Object.fromEntries(new URL(c.req.url).searchParams) })))
  .post(ROUTE.exec.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.exec.inner, c.req))
  .post(ROUTE.execKill.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.execKill.inner, c.req))
  .post(ROUTE.execDispose.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.execDispose.inner, c.req))
  .post(ROUTE.bgPost.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.bgPost.inner, c.req))
  .get(ROUTE.bgGet.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.bgGet.inner, c.req, forwardQuery(ROUTE.bgGet, { get: (k) => c.req.query(k) ?? undefined })))
  .post(ROUTE.bgKill.outer, (c) => forwardToWorkspace(c.env, c.req.param("id"), ROUTE.bgKill.inner, c.req))
  .get(ROUTE.stream.outer, (c) => forwardStream(c.env, c.req.param("id"), c.req.param("sid"), c.req))
  .notFound(() => Response.json({ error: "not found", hint: "check the path and method, then retry" }, { status: 404 }));

export type AppType = typeof app;

export default app;
