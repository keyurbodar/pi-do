import { appendEntry, runInSyncTx, sumResultUsage, entryHead } from "pi-cf/store/entries";
import { buildRuntime, clampThinkingLevel, resolveCatalogModel, supportedThinkingLevels, THINKING_LEVELS, type RuntimeEnv, type RuntimeModel } from "../model-runtime";
import { archiveMeta, compactionPending } from "../compaction";
import { checkedRotate } from "../stream";
import { MINT_WS_HINT, err, fmtModel, fmtSettings, fmtThinking, fmtUsage, json, saveSettings, type RouteHandler } from "./_shared";

const sessions: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const bad = ctx.requireSession(ws, null, "call POST /workspaces/:id/sessions on the Worker instead", "create one with POST /workspaces first, then POST /workspaces/:id/sessions");
  if (bad) return bad;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const retention: unknown = "retention" in body ? body.retention : "short";
  const effRetention = retention;
  if (effRetention !== "short" && effRetention !== "long") {
    return err("bad retention", 'retry with {"retention": "short"|"long"}; omit it for short', 400);
  }
  const name = typeof body.name === "string" ? body.name : null;
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const sessionId = crypto.randomUUID();
  const fence = crypto.randomUUID();
  const defaults = ctx.readSettings(ws);
  ctx.state.storage.sql.exec(
    "INSERT INTO sessions(sid, ws, created_at, ownerFence, revision, modelProvider, modelId, thinkingLevel, cacheRetention, name, cwd) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
    sessionId,
    ws,
    new Date().toISOString(),
    fence,
    defaults.provider,
    defaults.id,
    defaults.thinking,
    effRetention,
    name,
    cwd,
  );
  return json({ sessionId, fence, revision: 0, model: { provider: defaults.provider, id: defaults.id }, thinking: defaults.thinking, retention: effRetention, name, cwd });
};

const claim: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "call POST /workspaces/:id/sessions/:sid/claim on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  return ctx.enqueueSessionTurn(sid, async () => {
    const hint = "retry as POST /workspaces/:id/sessions/:sid/claim with JSON {fence, expected}";
    const rot = checkedRotate(ctx.readFence(sid), body, hint, (next) => ctx.rotateFence(sid, next));
    if (rot === null) return err("missing fence", hint, 400);
    if ("status" in rot) return json(rot.body, rot.status);
    return json({ sessionId: sid, fence: rot.fence, revision: rot.revision });
  });
};

const modelOrThinking: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const isThinking = url.pathname === "/thinking";
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(
    ws,
    sid,
    isThinking
      ? "call POST /workspaces/:id/sessions/:sid/thinking on the Worker instead"
      : "call POST /workspaces/:id/sessions/:sid/model on the Worker instead",
    MINT_WS_HINT,
  );
  if (bad) return bad;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!isThinking) {
    let provider: unknown = rec["provider"];
    let id: unknown = rec["id"];
    if (typeof provider !== "string" || provider.length === 0 || typeof id !== "string" || id.length === 0) {
      try {
        const runtime = buildRuntime(ctx.env as unknown as RuntimeEnv);
        if (runtime.stub) {
          return err("no model key", "set a provider key as a Worker secret, then retry", 400);
        }
        provider = runtime.model.provider;
        id = runtime.model.id;
      } catch (e) {
        if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
          const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
          return err(e.error, hint, 400);
        }
        return err("unknown model", "retry with a catalog model", 400);
      }
    }
    if (typeof provider !== "string" || provider.length === 0 || typeof id !== "string" || id.length === 0) {
      return err("unknown model", "retry with a catalog model", 400);
    }
    try {
      resolveCatalogModel(provider, id);
    } catch (e) {
      if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
        const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
        return err(e.error, hint, 404);
      }
      return err("unknown model", "retry with a catalog model", 404);
    }
    const rot = checkedRotate(ctx.readFence(sid), body, "retry the model switch with both {fence, expected}, or omit both for the legacy path", (next) => ctx.rotateFence(sid, next));
    if (rot !== null && "status" in rot) return json(rot.body, rot.status);
    const sql = ctx.state.storage.sql;
    const from = ctx.readTriple(sid);
    runInSyncTx(sql, () => {
      sql.exec("UPDATE sessions SET modelProvider = ?, modelId = ? WHERE sid = ?", provider, id, sid);
      saveSettings(sql, ws, provider, id, ctx.readSettings(ws).thinking);
      appendEntry(sql, sid, "model_change", {
        from: { provider: from?.provider ?? null, id: from?.id ?? null },
        to: { provider, id },
      });
    });
    const cur = ctx.readFence(sid);
    return fmtModel(sid, provider, id, rot, cur?.revision ?? 0);
  }
  const level: unknown = rec["level"];
  if (typeof level !== "string" || level.length === 0) {
    return err("missing level", 'retry as POST /workspaces/:id/sessions/:sid/thinking with JSON {"level": "high"}', 400);
  }
  const triple = ctx.readTriple(sid);
  let like: RuntimeModel | Record<string, never> = {};
  if (triple?.provider !== null && triple?.provider !== undefined && triple?.id !== null && triple?.id !== undefined) {
    try {
      like = resolveCatalogModel(triple.provider as string, triple.id as string);
    } catch (e) {
      if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
        const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
        return err(e.error, hint, 404);
      }
      return err("unknown model", "retry with a catalog model", 404);
    }
  } else {
    try {
      const runtime = buildRuntime(ctx.env as unknown as RuntimeEnv);
      if (!runtime.stub) like = runtime.model;
    } catch {
      like = {};
    }
  }
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    return err(`unknown thinking level: ${level}`, `supported levels: ${supportedThinkingLevels(like).join(", ")}`, 400);
  }
  const rotated = checkedRotate(ctx.readFence(sid), body, "retry the thinking switch with both {fence, expected}, or omit both for the legacy path", (next) => ctx.rotateFence(sid, next));
  if (rotated !== null && "status" in rotated) return json(rotated.body, rotated.status);
  const applied = clampThinkingLevel(like, level);
  const sql = ctx.state.storage.sql;
  runInSyncTx(sql, () => {
    sql.exec("UPDATE sessions SET thinkingLevel = ? WHERE sid = ?", applied, sid);
    appendEntry(sql, sid, "thinking_level_change", {
      from: triple?.thinking ?? null,
      requested: level,
      level: applied,
    });
  });
  const cur = ctx.readFence(sid);
  return fmtThinking(sid, applied, level, rotated, cur?.revision ?? 0);
};

const settings: RouteHandler = async (ctx, request, url) => {
  const ws = url.searchParams.get("ws") ?? "";
  const bad = ctx.requireSession(ws, null, "call PUT /workspaces/:id/settings on the Worker instead", "create one with POST /workspaces first, then set its defaults");
  if (bad) return bad;
  if (request.method === "GET") {
    const current = ctx.readSettings(ws);
    return fmtSettings(ws, current);
  }
  if (request.method === "POST" || request.method === "PUT") {
    let patchProvider: unknown;
    let patchId: unknown;
    let patchThinking: unknown;
    let hasProvider = false;
    let hasId = false;
    let hasThinking = false;
    try {
      const body: unknown = await request.json();
      if (body !== null && typeof body === "object") {
        if ("modelProvider" in body) {
          patchProvider = body.modelProvider;
          hasProvider = true;
        }
        if ("modelId" in body) {
          patchId = body.modelId;
          hasId = true;
        }
        if ("thinkingLevel" in body) {
          patchThinking = body.thinkingLevel;
          hasThinking = true;
        }
      }
    } catch {
      return err("bad settings", 'retry as PUT /workspaces/:id/settings with JSON {"modelProvider": "anthropic", "modelId": "claude-opus-4-6", "thinkingLevel": "high"}; omit keys to leave them, null clears', 400);
    }
    for (const [name, value] of [["modelProvider", patchProvider], ["modelId", patchId], ["thinkingLevel", patchThinking]] as Array<[string, unknown]>) {
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0)) {
        return err(`bad settings: ${name}`, `set ${name} to a non-empty string, null to clear, or omit it to leave it`, 400);
      }
    }
    const current = ctx.readSettings(ws);
    const next = {
      provider: hasProvider ? (patchProvider as string | null) : current.provider,
      id: hasId ? (patchId as string | null) : current.id,
      thinking: hasThinking ? (patchThinking as string | null) : current.thinking,
    };
    if ((next.provider === null) !== (next.id === null)) {
      return err("half model default", "set both modelProvider and modelId, or clear both with null", 400);
    }
    if (next.provider !== null && next.id !== null) {
      try {
        resolveCatalogModel(next.provider, next.id);
      } catch (e) {
        if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
          const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
          return err(e.error, hint, 404);
        }
      }
    }
    if (next.thinking !== null && !(THINKING_LEVELS as readonly string[]).includes(next.thinking)) {
      return err(`unknown thinking level: ${next.thinking}`, `supported levels: ${(THINKING_LEVELS as readonly string[]).join(", ")}`, 400);
    }
    saveSettings(ctx.state.storage.sql, ws, next.provider, next.id, next.thinking);
    return fmtSettings(ws, next);
  }
  return err("method not allowed", "use GET or PUT /workspaces/:id/settings", 405);
};

const meta: RouteHandler = (ctx, request, url) => {
  if (request.method !== "GET") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "retry as GET /workspaces/:id/sessions/:sid/meta on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  const sql = ctx.state.storage.sql;
  let created = "";
  let name: string | null = null;
  let cwd: string | null = null;
  for (const row of sql.exec("SELECT created_at, name, cwd FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws)) {
    if (row !== null && typeof row === "object" && "created_at" in row && typeof row.created_at === "string") {
      created = row.created_at;
    }
    if (row !== null && typeof row === "object" && "name" in row && typeof row.name === "string") {
      name = row.name;
    }
    if (row !== null && typeof row === "object" && "cwd" in row && typeof row.cwd === "string") {
      cwd = row.cwd;
    }
  }
  const { count, head } = entryHead(sql, sid);
  let leaf = head;
  for (const row of sql.exec("SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid)) {
    if (row !== null && typeof row === "object" && "leaf" in row && typeof row.leaf === "number") {
      leaf = row.leaf;
    }
  }
  let openRun: string | null = null;
  for (const row of sql.exec("SELECT runId FROM runs WHERE sid = ? AND status = ? LIMIT 1", sid, "open")) {
    if (row !== null && typeof row === "object" && "runId" in row && typeof row.runId === "string") {
      openRun = row.runId;
    }
  }
  const triple = ctx.readTriple(sid);
  const archive = archiveMeta(sql, sid);
  const usage = fmtUsage(sumResultUsage(sql, sid), ctx.sessionContextWindow(triple));
  return json({ sid, ws, created, name, cwd, head, count, leaf, openRun, model: { provider: triple?.provider ?? null, id: triple?.id ?? null }, thinking: triple?.thinking ?? null, retention: triple?.retention ?? "short", usage, compaction: { pending: compactionPending(sql, sid), archivePages: archive.pages, archiveTotal: archive.total } });
};

export const sessionRoutes: Record<string, RouteHandler> = {
  "/sessions": sessions,
  "/claim": claim,
  "/model": modelOrThinking,
  "/thinking": modelOrThinking,
  "/settings": settings,
  "/meta": meta,
};
