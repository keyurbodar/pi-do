import type { SessionHalt, SessionUsage } from "./session";
import type { EntryRow } from "./sql-util.ts";
import { CREATE_TABLES, drainPages, ensureTables, mapEntryRows, numField, parseJsonObject, readScalar, readSingleRow, toEntryRow } from "./sql-util.ts";

export interface EntriesSql {
  exec(query: string, ...bindings: unknown[]): Iterable<unknown>;
  // Present on DO SqlStorage; absent on the verify fake. Probed, never cast.
  transactionSync?(fn: () => void): void;
}

export type { EntryRow };

export function ensureEntriesSchema(sql: EntriesSql): void {
  ensureTables(sql, [CREATE_TABLES.piEntries, CREATE_TABLES.runs, CREATE_TABLES.piEntriesSidId]);
}

export function appendEntry(
  sql: EntriesSql,
  sid: string,
  type: string,
  body: unknown,
): number {
  const stored = typeof body === "string" ? body : JSON.stringify(body);
  const head = readScalar<unknown>(sql, "SELECT COALESCE(MAX(id), 0) AS head FROM pi_entries WHERE sid = ?", sid);
  const parent = typeof head === "number" ? head : 0;
  sql.exec("INSERT INTO pi_entries(sid, parent, type, body) VALUES (?, ?, ?, ?)", sid, parent, type, stored);
  const cursor = readScalar<unknown>(sql, "SELECT last_insert_rowid() AS id");
  if (typeof cursor !== "number" || cursor < 0) throw new Error("appendEntry: last_insert_rowid returned no row");
  sql.exec("UPDATE pi_entries SET cursor = ? WHERE id = ?", cursor, cursor);
  advanceSessionLeaf(sql, sid, cursor);
  return cursor;
}

export function advanceSessionLeaf(sql: EntriesSql, sid: string, cursor: number): void {
  try {
    sql.exec("UPDATE sessions SET leaf = ? WHERE sid = ?", cursor, sid);
  } catch {
  }
}

export function listEntries(
  sql: EntriesSql,
  sid: string,
  after: number | { after?: number; limit?: number } = 0,
  limit = 100,
): EntryRow[] {
  const a = typeof after === "object" && after !== null ? (after.after ?? 0) : after;
  const raw = typeof after === "object" && after !== null ? (after.limit ?? 100) : limit;
  if (!Number.isInteger(a) || a < 0) throw new Error("listEntries: after must be a non-negative integer");
  if (!Number.isInteger(raw) || raw < 0) throw new Error("listEntries: limit must be a non-negative integer");
  const l = Math.min(raw, 1000);
  return mapEntryRows(sql.exec(
    "SELECT id AS cursor, COALESCE(parent, 0) AS parent, type, body FROM pi_entries WHERE sid = ? AND id > ? ORDER BY id LIMIT ?",
    sid,
    a,
    l,
  ));
}

export function getEntry(sql: EntriesSql, sid: string, cursor: number): EntryRow | null {
  return toEntryRow(readSingleRow(
    sql,
    "SELECT id AS cursor, COALESCE(parent, 0) AS parent, type, body FROM pi_entries WHERE sid = ? AND id = ? LIMIT 1",
    sid,
    cursor,
  ));
}

export function entryHead(sql: EntriesSql, sid: string): { count: number; head: number } {
  const row = readSingleRow(sql, "SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS head FROM pi_entries WHERE sid = ?", sid);
  if (row !== null && typeof row.count === "number" && typeof row.head === "number") return { count: row.count, head: row.head };
  return { count: 0, head: 0 };
}

export function sessionLeaf(sql: EntriesSql, sid: string): number {
  try {
    const row = readSingleRow(sql, "SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid);
    if (row !== null && typeof row.leaf === "number" && Number.isInteger(row.leaf) && row.leaf > 0) return row.leaf;
  } catch {
  }
  return entryHead(sql, sid).head;
}

export function runInSyncTx(sql: EntriesSql, fn: () => void): void {
  const tx = sql.transactionSync;
  if (typeof tx === "function") tx.call(sql, fn);
  else fn();
}

function openRunInner(sql: EntriesSql, sid: string, runId: string): void {
  for (const row of sql.exec("SELECT runId FROM runs WHERE sid = ? AND status = ?", sid, "open")) {
    if (row === null || typeof row !== "object" || !("runId" in row)) continue;
    if (typeof row.runId !== "string" || row.runId === runId) continue;
    sql.exec(
      "UPDATE runs SET status = ? WHERE sid = ? AND runId = ?",
      "interrupted",
      sid,
      row.runId,
    );
    appendEntry(sql, sid, "interrupted", { runId: row.runId, interruptedBy: runId });
  }
  sql.exec(
    "INSERT OR REPLACE INTO runs(sid, runId, status) VALUES (?, ?, ?)",
    sid,
    runId,
    "open",
  );
}

export function openRun(sql: EntriesSql, sid: string, runId: string): void {
  runInSyncTx(sql, () => {
    openRunInner(sql, sid, runId);
  });
}

export function closeRun(sql: EntriesSql, sid: string, runId: string): void {
  sql.exec("UPDATE runs SET status = ? WHERE sid = ? AND runId = ?", "closed", sid, runId);
}

export interface TurnCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  output: string;
}
function recordTurnInner(
  sql: EntriesSql,
  sid: string,
  runId: string,
  prompt: string,
  toolCalls: TurnCall[],
  result: string,
  usage?: SessionUsage,
  halt?: SessionHalt | null,
): void {
  appendEntry(sql, sid, "prompt", { runId, prompt });
  for (const call of toolCalls) {
    appendEntry(sql, sid, "toolCall", { runId, id: call.id, tool: call.tool, args: call.args });
    appendEntry(sql, sid, "toolResult", { runId, id: call.id, tool: call.tool, output: call.output });
  }
  const resultBody: { runId: string; result: string; usage?: SessionUsage; halt?: SessionHalt } = usage === undefined ? { runId, result } : { runId, result, usage };
  if (halt !== undefined && halt !== null) resultBody.halt = halt;
  appendEntry(sql, sid, "result", resultBody);
  closeRun(sql, sid, runId);
}
export const recordTurn = recordTurnInner;

export function recordTurnWithOpen(
  sql: EntriesSql,
  sid: string,
  runId: string,
  prompt: string,
  toolCalls: TurnCall[],
  result: string,
  usage?: SessionUsage,
  halt?: SessionHalt | null,
): void {
  runInSyncTx(sql, () => {
    openRunInner(sql, sid, runId);
    recordTurnInner(sql, sid, runId, prompt, toolCalls, result, usage, halt);
  });
}

export function sumResultUsage(sql: EntriesSql, sid: string): SessionUsage {
  const sums: SessionUsage = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null };
  for (const entry of drainPages((after) => listEntries(sql, sid, { after, limit: 1000 }))) {
    if (entry.type !== "result") continue;
    const usage = parseResultUsage(entry.body);
    sums.inTokens += usage.inTokens;
    sums.outTokens += usage.outTokens;
    sums.cacheRead += usage.cacheRead;
    sums.costTotal += usage.costTotal;
    sums.elapsedMs += usage.elapsedMs;
  }
  return sums;
}

function parseResultUsage(body: string): Omit<SessionUsage, "tokensPerSec"> {
  const zero = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0 };
  const parsed = parseJsonObject(body);
  if (parsed === null || !("usage" in parsed)) return zero;
  const usage = parsed.usage;
  if (usage === null || typeof usage !== "object") return zero;
  const record = usage as Record<string, unknown>;
  return {
    inTokens: numField(record, "inTokens"),
    outTokens: numField(record, "outTokens"),
    cacheRead: numField(record, "cacheRead"),
    costTotal: numField(record, "costTotal"),
    elapsedMs: numField(record, "elapsedMs"),
    ...("retention" in record && record.retention === "long" ? { retention: "long" as const } : {}),
  };
}

export interface SessionUsageMeta extends SessionUsage {
  contextPct: number | null;
  hitPct: number;
}

export function withSessionRates(sums: SessionUsage, contextWindow: number | null): SessionUsageMeta {
  const tokensPerSec = sums.outTokens > 0 && sums.elapsedMs >= 100 ? (sums.outTokens * 1000) / sums.elapsedMs : null;
  const context = sums.inTokens + sums.outTokens + sums.cacheRead;
  const contextPct = typeof contextWindow === "number" && contextWindow > 0 ? (context / contextWindow) * 100 : null;
  const hitDenom = sums.inTokens + sums.cacheRead;
  return { ...sums, tokensPerSec, contextPct, hitPct: hitDenom > 0 ? (sums.cacheRead / hitDenom) * 100 : 0 };
}
