// inbox.ts — durable peer messaging for sessions.
//
// A send is one validated INSERT; delivery is the recipient's consuming turn
// pulling undelivered rows. Crash-safety is by construction (the row persists
// before any wake) and the at-least-once window is explicit: delivered_at is
// set inside the same sync transaction that persists the consuming turn's
// prompt entry, so a crash mid-turn leaves rows undelivered and re-delivered.
// `queued_at` claims rows for a wake turn; a claim older than INBOX_RECLAIM_MS
// is reclaimable, covering a server death between enqueue and consume.
import { readSingleRow } from "./sql-util.ts";

export type EntriesSql = import("./entries.ts").EntriesSql;

export const INBOX_DDL =
  "CREATE TABLE IF NOT EXISTS pi_inbox(ws TEXT, id TEXT PRIMARY KEY, thread TEXT, from_sid TEXT NOT NULL, to_sid TEXT NOT NULL, body TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL, delivered_at TEXT, outcome_cursor INTEGER, queued_at INTEGER)";

export function ensureInboxSchema(sql: EntriesSql): void {
  sql.exec(INBOX_DDL);
}

export interface InboxRow {
  id: string;
  ws: string;
  thread: string | null;
  fromSid: string;
  toSid: string;
  body: string;
  requestId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  outcomeCursor: number | null;
}

const SELECT_INBOX =
  "SELECT id, ws, thread, from_sid AS fromSid, to_sid AS toSid, body, request_id AS requestId, created_at AS createdAt, delivered_at AS deliveredAt, outcome_cursor AS outcomeCursor FROM pi_inbox";

function toInboxRow(row: unknown): InboxRow | null {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.ws !== "string" || typeof r.fromSid !== "string" || typeof r.toSid !== "string" || typeof r.body !== "string") return null;
  return {
    id: r.id,
    ws: r.ws,
    thread: typeof r.thread === "string" ? r.thread : null,
    fromSid: r.fromSid,
    toSid: r.toSid,
    body: r.body,
    requestId: typeof r.requestId === "string" ? r.requestId : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    deliveredAt: typeof r.deliveredAt === "string" ? r.deliveredAt : null,
    outcomeCursor: typeof r.outcomeCursor === "number" ? r.outcomeCursor : null,
  };
}

export type InsertInboxResult = { ok: true; row: InboxRow } | { ok: false; error: string; hint: string };

// Idempotent on (ws, from_sid, request_id): a retried send returns the
// original row, never a second one.
export function insertInbox(
  sql: EntriesSql,
  ws: string,
  fromSid: string,
  toSid: string,
  input: { body: unknown; thread?: unknown; requestId?: unknown },
): InsertInboxResult {
  ensureInboxSchema(sql);
  if (typeof input.body !== "string" || input.body.length === 0) {
    return { ok: false, error: "missing body", hint: 'retry with {"to": "<session id or name>", "body": "text"}' };
  }
  if (typeof input.requestId === "string" && input.requestId.length > 0) {
    const existing = readSingleRow(sql, `${SELECT_INBOX} WHERE ws = ? AND from_sid = ? AND request_id = ? LIMIT 1`, ws, fromSid, input.requestId);
    const row = toInboxRow(existing);
    if (row !== null) return { ok: true, row };
  }
  const id = crypto.randomUUID();
  const thread = typeof input.thread === "string" && input.thread.length > 0 ? input.thread : null;
  const requestId = typeof input.requestId === "string" && input.requestId.length > 0 ? input.requestId : null;
  sql.exec(
    "INSERT INTO pi_inbox(ws, id, thread, from_sid, to_sid, body, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ws,
    id,
    thread,
    fromSid,
    toSid,
    input.body,
    requestId,
    new Date().toISOString(),
  );
  return { ok: true, row: getInbox(sql, ws, id) as InboxRow };
}

export function getInbox(sql: EntriesSql, ws: string, id: string): InboxRow | null {
  return toInboxRow(readSingleRow(sql, `${SELECT_INBOX} WHERE ws = ? AND id = ? LIMIT 1`, ws, id));
}

// Rows ready for a wake turn: never delivered, and not claimed by a live
// wake turn (a claim older than the reclaim window is stale — the wake turn
// died before consuming).
export function listUndelivered(sql: EntriesSql, ws: string, sid: string, nowMs: number, reclaimMs: number): InboxRow[] {
  const out: InboxRow[] = [];
  for (const row of sql.exec(
    `${SELECT_INBOX} WHERE ws = ? AND to_sid = ? AND delivered_at IS NULL AND (queued_at IS NULL OR queued_at < ?) ORDER BY created_at`,
    ws,
    sid,
    nowMs - reclaimMs,
  )) {
    const parsed = toInboxRow(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// Claim rows for a wake turn: queued_at makes a concurrent second tick skip
// them; the reclaim window in listUndelivered covers a wake turn that died.
export function claimInbox(sql: EntriesSql, ws: string, sid: string, nowMs: number, reclaimMs: number): InboxRow[] {
  const rows = listUndelivered(sql, ws, sid, nowMs, reclaimMs);
  if (rows.length === 0) return [];
  sql.exec(
    `UPDATE pi_inbox SET queued_at = ? WHERE ws = ? AND to_sid = ? AND delivered_at IS NULL AND (queued_at IS NULL OR queued_at < ?)`,
    nowMs,
    ws,
    sid,
    nowMs - reclaimMs,
  );
  return rows;
}

export function markDelivered(sql: EntriesSql, ws: string, ids: string[], outcomeCursor: number | null): void {
  for (const id of ids) {
    sql.exec("UPDATE pi_inbox SET delivered_at = ?, outcome_cursor = ? WHERE ws = ? AND id = ?", new Date().toISOString(), outcomeCursor, ws, id);
  }
}

export function countUndelivered(sql: EntriesSql, ws: string, sid: string, nowMs: number, reclaimMs: number): number {
  return (
    readSingleRowCount(
      sql,
      "SELECT COUNT(*) AS n FROM pi_inbox WHERE ws = ? AND to_sid = ? AND delivered_at IS NULL AND (queued_at IS NULL OR queued_at < ?)",
      ws,
      sid,
      nowMs - reclaimMs,
    ) ?? 0
  );
}

function readSingleRowCount(sql: EntriesSql, query: string, ...bind: unknown[]): number | null {
  for (const row of sql.exec(query, ...bind)) {
    if (row !== null && typeof row === "object" && "n" in row && typeof (row as Record<string, unknown>).n === "number") {
      return (row as Record<string, unknown>).n as number;
    }
  }
  return null;
}

export function listThread(sql: EntriesSql, ws: string, thread: string): InboxRow[] {
  const out: InboxRow[] = [];
  for (const row of sql.exec(`${SELECT_INBOX} WHERE ws = ? AND thread = ? ORDER BY created_at`, ws, thread)) {
    const parsed = toInboxRow(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function listInbox(sql: EntriesSql, ws: string, sid: string): InboxRow[] {
  const out: InboxRow[] = [];
  for (const row of sql.exec(`${SELECT_INBOX} WHERE ws = ? AND (to_sid = ? OR from_sid = ?) ORDER BY created_at`, ws, sid, sid)) {
    const parsed = toInboxRow(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
