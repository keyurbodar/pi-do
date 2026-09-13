import { countUndelivered, ensureInboxSchema, getInbox, insertInbox, listInbox, listThread, type InboxRow } from "pi-cf/store/inbox";
import { rearmInbox } from "../inbox";
import { MINT_WS_HINT, err, json, type RouteHandler } from "./_shared";
import { ROUTE, ownedRoutes, registerHandler } from "./table";

function fmtInbox(r: InboxRow): Record<string, unknown> {
  return {
    id: r.id,
    thread: r.thread,
    from: r.fromSid,
    to: r.toSid,
    body: r.body,
    requestId: r.requestId,
    createdAt: r.createdAt,
    deliveredAt: r.deliveredAt,
    outcomeCursor: r.outcomeCursor,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const inbox: RouteHandler = async (ctx, request, url) => {
  if (request.method !== "POST" && request.method !== "GET") return null;
  const ws = url.searchParams.get("ws") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const bad = ctx.requireSession(ws, sid, "call /workspaces/:id/sessions/:sid/inbox on the Worker instead", MINT_WS_HINT);
  if (bad) return bad;
  const sql = ctx.state.storage.sql;
  ensureInboxSchema(sql);
  if (request.method === "GET") {
    const thread = url.searchParams.get("thread");
    const rows = thread !== null ? listThread(sql, ws, thread) : listInbox(sql, ws, sid);
    return json({ sid, messages: rows.map(fmtInbox) });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof rec["to"] !== "string" || rec["to"].length === 0) {
    return err("missing recipient", 'retry with {"to": "<session id or name>", "body": "text"}', 400);
  }
  if (rec["to"] === sid) {
    return err("self-send", "the recipient must be a different session; a session cannot message itself", 400);
  }
  // Spawn-by-message: an unknown recipient materializes as a new named
  // session on first message. The inbox row is the visible record of who
  // spawned whom and why.
  let toSid = rec["to"];
  if (!ctx.sessionExists(ws, toSid)) {
    for (const row of sql.exec("SELECT sid FROM sessions WHERE ws = ? AND name = ? LIMIT 1", ws, toSid)) {
      if (row !== null && typeof row === "object" && typeof (row as Record<string, unknown>).sid === "string") {
        toSid = (row as Record<string, unknown>).sid as string;
      }
      break;
    }
    if (!ctx.sessionExists(ws, toSid)) toSid = ctx.mintSession(ws, toSid, (rec["body"] as string).slice(0, 8192));
  }
  const result = insertInbox(sql, ws, sid, toSid, { body: rec["body"], thread: rec["thread"], requestId: rec["requestId"] });
  if (!result.ok) return err(result.error, result.hint, 400);
  rearmInbox(sql, Date.now());
  await ctx.streamHost(ws, sid).pokeAlarm();
  if (rec["wait"] !== true) return json({ sid, message: fmtInbox(result.row) }, 201);
  const timeoutS = typeof rec["timeout"] === "number" && Number.isFinite(rec["timeout"]) ? Math.min(rec["timeout"], 120) : 30;
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await sleep(250);
    const row = getInbox(sql, ws, result.row.id);
    if (row !== null && row.outcomeCursor !== null) return json({ sid, message: fmtInbox(row) }, 200);
  }
  const final = getInbox(sql, ws, result.row.id);
  return json({ sid, message: final === null ? null : fmtInbox(final), ack: "timeout" }, 202);
};

registerHandler("inbox", ROUTE.inbox, inbox);

export const inboxRoutes: Record<string, RouteHandler> = ownedRoutes("inbox");
