import { createRoutine, deleteRoutine, ensureRoutinesSchema, getRoutine, listRoutines } from "../routines";
import { MINT_WS_HINT, err, json, type RouteHandler } from "./_shared";
import { ROUTE, ownedRoutes, registerHandler } from "./table";

function fmtRoutine(r: Awaited<ReturnType<typeof listRoutines>>[number]): Record<string, unknown> {
  return {
    id: r.id,
    sid: r.sid,
    schedule: { kind: r.scheduleKind, spec: r.scheduleSpec },
    prompt: r.prompt,
    nextRunAt: r.nextRunAtMs === null ? null : new Date(r.nextRunAtMs).toISOString(),
    expireAt: r.expireAtMs === null ? null : new Date(r.expireAtMs).toISOString(),
    maxRuns: r.maxRuns,
    runCount: r.runCount,
    active: r.nextRunAtMs !== null,
  };
}

const routines: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "call /workspaces/:id/sessions/:sid/routines on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  const sql = ctx.state.storage.sql;
  ensureRoutinesSchema(sql);
  if (request.method === "GET") return json({ sid, routines: listRoutines(sql, ws).map(fmtRoutine) });
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (id.length === 0) return err("missing routine id", "retry as DELETE /workspaces/:id/sessions/:sid/routines?id=<routine id>", 400);
    if (!deleteRoutine(sql, ws, id)) return err("unknown routine", "retry with an id from GET /workspaces/:id/sessions/:sid/routines", 404);
    await ctx.streamHost(ws, sid).pokeAlarm();
    return json({ deleted: id });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const maxRuns = rec["maxRuns"] === undefined ? undefined : Number(rec["maxRuns"]);
  const result = createRoutine(sql, ws, sid, {
    kind: rec["kind"],
    spec: rec["spec"],
    prompt: rec["prompt"],
    expireAt: rec["expireAt"],
    maxRuns,
    createdBy: "api",
    requestId: typeof rec["requestId"] === "string" ? rec["requestId"] : null,
  });
  if (!result.ok) return err(result.error, result.hint, result.error === "too many active routines" ? 409 : 400);
  await ctx.streamHost(ws, sid).pokeAlarm();
  return json({ sid, routine: fmtRoutine(result.routine) }, 201);
};

registerHandler("routines", ROUTE.routines, routines);

export const routineRoutes: Record<string, RouteHandler> = ownedRoutes("routines");
