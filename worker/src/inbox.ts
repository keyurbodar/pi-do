// inbox.ts — wake plumbing over the durable pi_inbox table (pi-cf/store/inbox).
//
// There is no channel and no push: a send persists the row and points the mux
// alarm at now. The INBOX_JOB groups undelivered rows per recipient session and
// enqueues one wake turn per session through the normal turn queue — a busy
// session delays its wake (the queued turn is serialized), and a wake turn that
// finds its rows already consumed exits without running the model.
import { claimInbox, countUndelivered, ensureInboxSchema, type InboxRow } from "pi-cf/store/inbox";
import type { EntriesSql } from "pi-cf/store/entries";
import { cancelJob, ensureAlarmMuxSchema, scheduleJob } from "./alarm-mux";

export const INBOX_JOB = "inbox";
export const INBOX_RECLAIM_MS = 120_000;
export const INBOX_REARM_MS = 5_000;

export function rearmInbox(sql: EntriesSql, atMs: number = Date.now() + INBOX_REARM_MS): number | null {
  ensureInboxSchema(sql);
  ensureAlarmMuxSchema(sql);
  cancelJob(sql, INBOX_JOB);
  const any = countAnyUndelivered(sql);
  if (!any) return null;
  return scheduleJob(sql, INBOX_JOB, atMs);
}

function countAnyUndelivered(sql: EntriesSql): boolean {
  for (const row of sql.exec("SELECT 1 AS one FROM pi_inbox WHERE delivered_at IS NULL LIMIT 1")) {
    if (row !== null) return true;
  }
  return false;
}

function recipientsWithUndelivered(sql: EntriesSql, nowMs: number): Array<{ ws: string; sid: string }> {
  const out: Array<{ ws: string; sid: string }> = [];
  const seen = new Set<string>();
  for (const row of sql.exec(
    "SELECT ws, to_sid AS sid FROM pi_inbox WHERE delivered_at IS NULL AND (queued_at IS NULL OR queued_at < ?) ORDER BY created_at",
    nowMs - INBOX_RECLAIM_MS,
  )) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.ws !== "string" || typeof r.sid !== "string") continue;
    const key = `${r.ws}\u0000${r.sid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ws: r.ws, sid: r.sid });
  }
  return out;
}

// One prompt carrying every undelivered message for the session. The sentinel
// line is the wake marker; the bodies ride with it because the model has no
// pull tool — this IS the pull.
export function inboxPrompt(rows: InboxRow[]): string {
  const lines = rows.map((r) => (r.thread === null ? `message from ${r.fromSid}: ${r.body}` : `message from ${r.fromSid} in thread ${r.thread}: ${r.body}`));
  return `<inbox-changed count="${rows.length}"/>\n\n${lines.join("\n")}`;
}

// Alarm body: claim and deliver each recipient's undelivered rows through its
// normal turn queue. deliver() receives the claimed rows and MUST persist the
// carrying turn before marking them delivered (at-least-once; a crash mid-turn
// leaves rows claimable again after the reclaim window). Always rearms while
// any undelivered row exists, so a send landing mid-alarm is never stranded.
export async function deliverDueInbox(sql: EntriesSql, nowMs: number, deliver: (ws: string, sid: string, rows: InboxRow[]) => Promise<void>): Promise<number> {
  ensureInboxSchema(sql);
  let delivered = 0;
  for (const recipient of recipientsWithUndelivered(sql, nowMs)) {
    const rows = claimInbox(sql, recipient.ws, recipient.sid, nowMs, INBOX_RECLAIM_MS);
    if (rows.length === 0) continue;
    await deliver(recipient.ws, recipient.sid, rows);
    delivered += rows.length;
  }
  rearmInbox(sql);
  return delivered;
}
