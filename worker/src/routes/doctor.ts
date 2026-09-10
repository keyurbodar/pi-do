import { reportWorkspaceDoctor } from "../doctor";
import type { RuntimeEnv } from "../model-runtime";
import { json, type RouteHandler } from "./_shared";

const doctor: RouteHandler = (ctx, request, url) => {
  if (request.method !== "GET") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const bad = ctx.requireSession(ws, null, "call GET /workspaces/:id/doctor on the Worker instead", "create one with POST /workspaces first, then check it");
  if (bad) return bad;
  return json(reportWorkspaceDoctor(ctx.state.storage.sql, ctx.env as unknown as RuntimeEnv, ws));
};

export const doctorRoutes: Record<string, RouteHandler> = {
  "/doctor": doctor,
};
