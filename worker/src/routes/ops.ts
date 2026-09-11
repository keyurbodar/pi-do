import { runInSyncTx } from "pi-cf/store/entries";
import { keyedProviders, listCatalogModels, type RuntimeEnv } from "../model-runtime";
import { createWorkspaceFs, gateArgv, hasGitDir, notARepoBody, NotARepoError, runGitArgv } from "../git";
import { bgSchema, execSchema, handleSchema, sidSchema } from "../schemas";
import { EXEC_TIMEOUT_MS } from "../shell-exec";
import { MINT_WS_HINT, err, json, readValidated, type RouteHandler } from "./_shared";
import { ROUTE, ownedRoutes, registerHandler } from "./table";

const git: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "call POST /workspaces/:id/sessions/:sid/git on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  let argv: unknown;
  try {
    const body: unknown = await request.json();
    if (body !== null && typeof body === "object" && "argv" in body) {
      argv = body.argv;
    }
  } catch {
    argv = undefined;
  }
  const gate = gateArgv(argv);
  if (!gate.ok) return err(gate.error, gate.hint, gate.status);
  try {
    const rows = [
      ...ctx.state.storage.sql.exec("SELECT path, body FROM files WHERE ws = ?", ws),
    ] as unknown as Array<{ path: string; body: ArrayBuffer | Uint8Array }>;
    const files = rows.map((r) => ({
      path: r.path,
      body: r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body),
    }));
    if (gate.argv[0] !== "init" && gate.argv[0] !== "clone" && !hasGitDir(files)) return json(notARepoBody(), 404);
    const result = await runGitArgv(files, gate.argv);
    if (result.upserts.length > 0 || result.deletes.length > 0) {
      const now = new Date().toISOString();
      const sql = ctx.state.storage.sql;
      runInSyncTx(sql, () => {
        for (const up of result.upserts) {
          sql.exec(
            "INSERT OR REPLACE INTO files(ws, path, body, updated_at) VALUES (?, ?, ?, ?)",
            ws,
            up.path,
            up.body,
            now,
          );
        }
        for (const del of result.deletes) {
          sql.exec("DELETE FROM files WHERE ws = ? AND path = ?", ws, del);
        }
      });
    }
    if (result.exitCode === 0) return json({ stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    if (/not a git repository/i.test(result.stderr)) return json(notARepoBody(), 404);
    const msg = (result.stderr || result.stdout || "git failed").trim().split("\n")[0].slice(0, 300);
    return err(msg, `git ${gate.argv[0]} exited ${result.exitCode}`, 400);
  } catch (e) {
    if (e instanceof NotARepoError) return json(notARepoBody(), 404);
    const msg = e instanceof Error ? e.message : String(e ?? "git failed");
    if (/not a git repository/i.test(msg)) return json(notARepoBody(), 404);
    return err(msg.slice(0, 300), `retry with argv ["status"] or ["clone", "<https-url>"]`, 400);
  }
};

const exec: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const parsed = await readValidated(request, "exec", execSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const bad = ctx.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
  if (bad) return bad;
  let result;
  try {
    result = await ctx.env.SHELL_WORKER.exec({ command: body.command, cwd: body.cwd, env: body.env, sid: body.sid });
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
  return json({ stdout: result.stdout, stderr: result.stderr, exit: result.exit });
};

const execKill: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const parsed = await readValidated(request, "execKill", sidSchema);
  if (!parsed.ok) return parsed.response;
  const bad = ctx.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
  if (bad) return bad;
  try {
    const outcome = await ctx.env.SHELL_WORKER.kill({ sid: parsed.value.sid });
    return json({ killed: outcome.killed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("no such exec session")) {
      return err(message, "run one command with that sid first to create the session", 404);
    }
    throw e;
  }
};

const execDispose: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const parsed = await readValidated(request, "execDispose", sidSchema);
  if (!parsed.ok) return parsed.response;
  const bad = ctx.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
  if (bad) return bad;
  const outcome = await ctx.env.SHELL_WORKER.dispose({ sid: parsed.value.sid });
  return json({ disposed: outcome.disposed, stdoutBytes: outcome.stdoutBytes, stderrBytes: outcome.stderrBytes });
};

const bg: RouteHandler = async (ctx, request, url) => {
  const ws = url.searchParams.get("ws") ?? "";
  if (request.method === "POST") {
    const parsed = await readValidated(request, "bg", bgSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const bad = ctx.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
    if (bad) return bad;
    try {
      const outcome = await ctx.env.SHELL_WORKER.bgStart({ command: body.command, cwd: body.cwd, env: body.env });
      return json({ handle: outcome.handle });
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
  }
  if (request.method === "GET") {
    const bad = ctx.requireSession(ws, null, "call GET /workspaces/:id/bg on the Worker instead", "create one with POST /workspaces first");
    if (bad) return bad;
    const handle = url.searchParams.get("handle");
    if (handle === null || handle.length === 0) {
      return err("missing handle", "retry as GET /workspaces/:id/bg?handle=H with the handle from POST /workspaces/:id/bg", 400);
    }
    try {
      return json(await ctx.env.SHELL_WORKER.bgRead({ handle }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("no such bg process")) {
        return err(message, "start one with POST /workspaces/:id/bg first, or it was killed", 404);
      }
      throw e;
    }
  }
  return null;
};

const bgKill: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const parsed = await readValidated(request, "bgKill", handleSchema);
  if (!parsed.ok) return parsed.response;
  const bad = ctx.requireSession(ws, null, "call POST /workspaces/:id/exec on the Worker instead", "create one with POST /workspaces first");
  if (bad) return bad;
  try {
    const outcome = await ctx.env.SHELL_WORKER.bgKill({ handle: parsed.value.handle });
    return json({ killed: outcome.killed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("no such bg process")) {
      return err(message, "start one with POST /workspaces/:id/bg first, or it was killed", 404);
    }
    throw e;
  }
};

const models: RouteHandler = (ctx, request, url) => {
  if (request.method !== "GET") return null;
  const only = url.searchParams.get("provider");
  const found = listCatalogModels().filter((m) => only === null || m.provider === only);
  if (only !== null && found.length === 0) {
    return err(`unknown provider: ${only}`, "retry GET /models without ?provider to list the catalog", 404);
  }
  const keyed = keyedProviders(ctx.env as unknown as RuntimeEnv).map((provider) => provider.id);
  return json({ models: found, keyed });
};

registerHandler("ops", ROUTE.git, git);
registerHandler("ops", ROUTE.exec, exec);
registerHandler("ops", ROUTE.execKill, execKill);
registerHandler("ops", ROUTE.execDispose, execDispose);
// POST and GET share the bg handler and inner path; the two forward shapes
// are declared separately as ROUTE.bgPost and ROUTE.bgGet.
registerHandler("ops", ROUTE.bgPost, bg);
registerHandler("ops", ROUTE.bgKill, bgKill);
registerHandler("ops", ROUTE.modelsInner, models);

export const opRoutes: Record<string, RouteHandler> = ownedRoutes("ops");
