import { createGroup, deleteGroup, ensureGroupsSchema, getGroup, listGroups, listMembers } from "pi-cf/store/groups";
import { resolveSendTarget } from "../groups";
import { insertInbox, listThread } from "pi-cf/store/inbox";
import type { EntriesSql } from "pi-cf/store/entries";
import { rearmInbox } from "../inbox";
import { earliestDeadline } from "../alarm-mux";
import { MINT_WS_HINT, err, json, type RouteHandler } from "./_shared";
import { ROUTE, ownedRoutes, registerHandler } from "./table";
import type { RouteCtx } from "./_shared";

function fmtGroup(sql: EntriesSql, ws: string, g: { id: string; name: string; thread: string }) {
  return { id: g.id, name: g.name, thread: g.thread, members: listMembers(sql, ws, g.id) };
}

const groups: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const bad = ctx.requireSession(ws, url.searchParams.get("sid") ?? "", "call /workspaces/:id/groups on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  const sql = ctx.state.storage.sql;
  ensureGroupsSchema(sql);
  const gid = url.searchParams.get("id") ?? "";

  if (request.method === "GET") {
    if (gid.length === 0) return json({ ws, groups: listGroups(sql, ws).map((g) => fmtGroup(sql, ws, g)) });
    const group = getGroup(sql, ws, gid);
    if (group === null) return err("unknown group", "retry with an id from GET /workspaces/:id/groups", 404);
    return json({ ws, group: fmtGroup(sql, ws, group) });
  }
  if (request.method === "DELETE") {
    if (gid.length === 0) return err("missing group id", "retry as DELETE /workspaces/:id/groups?id=<group id>", 400);
    if (!deleteGroup(sql, ws, gid)) return err("unknown group", "retry with an id from GET /workspaces/:id/groups", 404);
    return json({ deleted: gid });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const members = Array.isArray(rec["members"]) ? rec["members"].filter((m): m is string => typeof m === "string") : [];
  if (typeof rec["name"] !== "string" || rec["name"].length === 0 || members.length < 2) {
    return err("bad group", 'retry with {"name": "crew", "members": ["bot-a", "bot-b"]} — at least two members (ids or names; unknown names materialize new sessions)', 400);
  }
  const resolved: string[] = [];
  for (const member of members) {
    const target = resolveGroupMember(ctx, ws, member);
    resolved.push(target);
  }
  if (getGroup(sql, ws, rec["name"]) !== null) {
    return err("duplicate group name", "group names are unique per workspace; pick another name", 409);
  }
  const group = createGroup(sql, ws, rec["name"], resolved);
  return json({ ws, group: fmtGroup(sql, ws, group) }, 201);
};

// Members resolve like send targets minus materialization: create-time
// members must exist (id or name); spawning is the inbox send's job.
function resolveGroupMember(ctx: RouteCtx, ws: string, ref: string): string {
  if (ctx.sessionExists(ws, ref)) return ref;
  for (const row of ctx.state.storage.sql.exec("SELECT sid FROM sessions WHERE ws = ? AND name = ? LIMIT 1", ws, ref)) {
    if (row !== null && typeof row === "object" && typeof (row as Record<string, unknown>).sid === "string") {
      return (row as Record<string, unknown>).sid as string;
    }
  }
  return ref;
}

const groupMessages: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST" && request.method !== "GET") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const gid = url.searchParams.get("id") ?? "";
  const from = url.searchParams.get("sid") ?? "user";
  const bad = ctx.requireSession(ws, from === "user" ? null : from, "retry as POST /workspaces/:id/groups/messages with {from, body} instead", MINT_WS_HINT);
  if (bad && from !== "user") return bad;
  const sql = ctx.state.storage.sql;
  ensureGroupsSchema(sql);
  const group = getGroup(sql, ws, gid);
  if (group === null) return err("unknown group", "retry with an id from GET /workspaces/:id/groups", 404);

  if (request.method === "GET") return json({ group: fmtGroup(sql, ws, group), messages: listThread(sql, ws, group.thread) });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof rec["body"] !== "string" || rec["body"].length === 0) {
    return err("missing body", 'retry with {"body": "text"}', 400);
  }
  const requestId = typeof rec["requestId"] === "string" ? rec["requestId"] : null;
  const members = listMembers(sql, ws, group.id).filter((m) => m !== from);
  if (members.length === 0) return err("empty group", "no members to deliver to besides the sender", 400);
  const ids: string[] = [];
  for (const member of members) {
    const result = insertInbox(sql, ws, from, member, { body: rec["body"], thread: group.thread, requestId: requestId === null ? undefined : `${requestId}:${member}` });
    if (!result.ok) return err(result.error, result.hint, 400);
    ids.push(result.row.id);
  }
  rearmInbox(sql, Date.now());
  const next = earliestDeadline(sql);
  if (next !== null) await ctx.state.storage.setAlarm(next);
  return json({ group: fmtGroup(sql, ws, group), delivered: ids.length, thread: group.thread }, 201);
};

registerHandler("groups", ROUTE.groups, groups);
registerHandler("groupMessages", ROUTE.groupMessages, groupMessages);

export const groupRoutes: Record<string, RouteHandler> = ownedRoutes("groups");
export const groupMessageRoutes: Record<string, RouteHandler> = ownedRoutes("groupMessages");
