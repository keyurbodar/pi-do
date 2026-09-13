import { closeRun, entryHead, listEntries, openRun, recordTurnWithOpen } from "pi-cf/store/entries";
import { buildRuntime, clampThinkingLevel, resolveCatalogModel, supportedThinkingLevels, THINKING_LEVELS, type RuntimeEnv, type RuntimeModel } from "../model-runtime";
import { acceptStream, checkedRotate, executeTurn, parseBudgets, type TurnSink } from "../stream";
import { readArchivePage, runCompaction } from "../compaction";
import { sessionSummarizer } from "../summarizer";
import { MINT_WS_HINT, err, json, type RouteHandler } from "./_shared";
import { ROUTE, ownedRoutes, registerHandler } from "./table";

const run: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "call POST /workspaces/:id/sessions/:sid/run on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const prompt: unknown = rec["prompt"];
  const oneShotModel: unknown = "model" in rec ? rec["model"] : undefined;
  const plan = rec["plan"] === true;
  const oneShotThinking: unknown = "thinking" in rec ? rec["thinking"] : undefined;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return err("missing prompt", 'retry as POST /workspaces/:id/sessions/:sid/run with JSON {"prompt": "read seed.txt"}', 400);
  }
  const budgets = parseBudgets(rec["budgets"]);
  if (!budgets.ok) return err(budgets.error, budgets.hint, 400);
  let overrideProvider: string | null = null;
  let overrideId: string | null = null;
  if (oneShotModel !== undefined) {
    if (typeof oneShotModel === "string") {
      const slash = oneShotModel.indexOf("/");
      if (slash > 0) {
        overrideProvider = oneShotModel.slice(0, slash);
        overrideId = oneShotModel.slice(slash + 1);
      }
    } else if (oneShotModel !== null && typeof oneShotModel === "object" && "provider" in oneShotModel && "id" in oneShotModel) {
      if (typeof oneShotModel.provider === "string" && typeof oneShotModel.id === "string") {
        overrideProvider = oneShotModel.provider;
        overrideId = oneShotModel.id;
      }
    }
    if (overrideProvider === null || overrideProvider.length === 0 || overrideId === null || overrideId.length === 0) {
      return err("bad model override", 'retry with {"model": {"provider": "anthropic", "id": "claude-opus-4-6"}} or {"model": "anthropic/claude-opus-4-6"}', 400);
    }
  }
  if (oneShotThinking !== undefined && (typeof oneShotThinking !== "string" || oneShotThinking.length === 0)) {
    return err("bad thinking override", 'retry with {"thinking": "high"} using a supported level', 400);
  }
  const stored = ctx.readTriple(sid);
  const effProvider = overrideProvider ?? stored?.provider ?? null;
  const effId = overrideId ?? stored?.id ?? null;
  let catalog: RuntimeModel | null = null;
  if (effProvider !== null && effId !== null) {
    try {
      catalog = resolveCatalogModel(effProvider, effId);
    } catch (e) {
      if (e !== null && typeof e === "object" && "error" in e && typeof e.error === "string") {
        const hint = "hint" in e && typeof e.hint === "string" ? e.hint : "retry with a catalog model";
        return err(e.error, hint, 404);
      }
      return err("unknown model", "retry with a catalog model", 404);
    }
  }
  const wantThinking = (oneShotThinking as string | undefined) ?? stored?.thinking ?? null;
  let like: RuntimeModel | Record<string, never> = catalog ?? {};
  if (catalog === null && wantThinking !== null) {
    const fallback = buildRuntime(ctx.env as unknown as RuntimeEnv);
    if (!fallback.stub) like = fallback.model;
  }
  if (oneShotThinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(oneShotThinking as string)) {
    return err(`unknown thinking level: ${oneShotThinking as string}`, `supported levels: ${supportedThinkingLevels(like).join(", ")}`, 400);
  }
  const effThinking = wantThinking === null ? null : clampThinkingLevel(like, wantThinking);
  return ctx.enqueueSessionTurn(sid, async () => {
    const rot = checkedRotate(ctx.readFence(sid), body, "retry the run with both {fence, expected}, or omit both for the legacy path", (next) => ctx.rotateFence(sid, next));
    if (rot !== null && "status" in rot) return json(rot.body, rot.status);
    const rotated = rot;
    const sql = ctx.state.storage.sql;
    const runId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    let response: Response | null = null;
    const sink: TurnSink = {
      push() {},
      done(doneId, turn, runtime) {
        recordTurnWithOpen(sql, sid, doneId, prompt, turn.toolCalls, turn.result, turn.usage, turn.halt ?? null);
        const out = { result: turn.result, toolCalls: turn.toolCalls, runtime, usage: turn.usage, turnId, ...(turn.halt ? { halt: turn.halt } : {}) };
        response = rotated !== null ? json({ ...out, fence: rotated.fence, revision: rotated.revision }) : json(out);
      },
      fail(failId, error, hint, status, opened) {
        if (opened) {
          openRun(sql, sid, failId);
          closeRun(sql, sid, failId);
        }
        response = json({ error, hint }, status);
      },
      aborted() {},
    };
    await executeTurn(ctx.streamHost(ws, sid), { prompt, catalog, thinking: effThinking, runId, turnId, budgets: budgets.budgets, plan }, sink);
    return response ?? json({ error: "run failed", hint: "retry the run with a simpler prompt" }, 500);
  });
};

const stream: RouteHandler = (ctx, request, url) => {
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  return acceptStream(request, ctx.streamHost(ws, sid), ctx.state);
};

const entries: RouteHandler = (ctx, request, url) => {
  if (request.method !== "GET") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "retry as GET /workspaces/:id/sessions/:sid/entries on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  const rawAfter = url.searchParams.get("after") ?? "0";
  const after = Number(rawAfter);
  if (!Number.isInteger(after) || after < 0) {
    return err("bad after", "retry with ?after=N where N is a non-negative cursor, e.g. ?after=0", 400);
  }
  const rawLimit = url.searchParams.get("limit") ?? "100";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 0) {
    return err("bad limit", "retry with ?limit=L where L is a non-negative integer up to 1000, e.g. ?limit=100", 400);
  }
  const sql = ctx.state.storage.sql;
  const { count, head } = entryHead(sql, sid);
  return json({ entries: listEntries(sql, sid, { after, limit }), head, count });
};

const compact: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "retry as POST /workspaces/:id/sessions/:sid/compact on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  let instructions: string | undefined;
  try {
    const body: unknown = await request.json();
    if (body !== null && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      if (rec["instructions"] !== undefined) {
        if (typeof rec["instructions"] !== "string" || rec["instructions"].length === 0 || rec["instructions"].length > 2000) {
          return err("bad instructions", 'retry with {"instructions": "<focus text>"} (at most 2000 chars) or omit it', 400);
        }
        instructions = rec["instructions"];
      }
    }
  } catch {
    // no body: plain forced compaction
  }
  return ctx.enqueueSessionTurn(sid, async () => {
    const out = await runCompaction(ctx.state.storage.sql, sid, true, [], sessionSummarizer(ctx.env as unknown as RuntimeEnv, ctx.state.storage.sql, sid), instructions);
    return json({ sid, ...out });
  });
};

const archive: RouteHandler = (ctx, request, url) => {
  if (request.method !== "GET") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "retry as GET /workspaces/:id/sessions/:sid/archive on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  const page = Number(url.searchParams.get("page") ?? "1");
  if (!Number.isInteger(page) || page < 1) {
    return err("bad page", "retry with ?page=N where N is a positive integer, e.g. ?page=1", 400);
  }
  const sql = ctx.state.storage.sql;
  return json({ sid, ...readArchivePage(sql, sid, page) });
};

registerHandler("turns", ROUTE.run, run);
registerHandler("turns", ROUTE.stream, stream);
registerHandler("turns", ROUTE.entries, entries);
registerHandler("turns", ROUTE.compact, compact);
registerHandler("turns", ROUTE.archive, archive);

export const turnRoutes: Record<string, RouteHandler> = ownedRoutes("turns");
