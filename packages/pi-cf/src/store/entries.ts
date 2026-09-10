import type { SessionHalt, SessionUsage } from "../agent/session";
import type { EntryRow } from "./sql-util.ts";
import { CREATE_TABLES, ensureTables, existsBy, mapEntryRows, numField, parseJsonObject, readScalar, readSingleRow, toEntryRow } from "./sql-util.ts";

export interface EntriesSql {
  exec(query: string, ...bindings: unknown[]): Iterable<unknown>;
  // Present on DO SqlStorage; absent on the verify fake. Probed, never cast.
  transactionSync?(fn: () => void): void;
}

export type { EntryRow };

export function ensureEntriesSchema(sql: EntriesSql): void {
  ensureTables(sql, [CREATE_TABLES.piEntries, CREATE_TABLES.runs, CREATE_TABLES.piEntriesSidId, CREATE_TABLES.sessionTotals]);
  backfillSessionLeafs(sql);
  backfillSessionTotals(sql);
}

export function appendEntry(
  sql: EntriesSql,
  sid: string,
  type: string,
  body: unknown,
): number {
  const stored = typeof body === "string" ? body : JSON.stringify(body);
  let cursor = -1;
  runInSyncTx(sql, () => {
    const leaf = readScalar<unknown>(sql, "SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid);
    const parent = typeof leaf === "number" && Number.isInteger(leaf) && leaf > 0 ? leaf : 0;
    sql.exec("INSERT INTO pi_entries(sid, parent, type, body) VALUES (?, ?, ?, ?)", sid, parent, type, stored);
    const id = readScalar<unknown>(sql, "SELECT last_insert_rowid() AS id");
    if (typeof id !== "number" || id < 0) throw new Error("appendEntry: last_insert_rowid returned no row");
    cursor = id;
    advanceSessionLeaf(sql, sid, cursor);
  });
  return cursor;
}

export function advanceSessionLeaf(sql: EntriesSql, sid: string, cursor: number): void {
  sql.exec("UPDATE sessions SET leaf = ? WHERE sid = ?", cursor, sid);
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

// Re-entrant: appendEntry runs its own tx, so callers that already hold the
// tx (recordTurnWithOpen, routes) must not open a nested SQLite transaction.
const txActive = new WeakSet<object>();

export function runInSyncTx(sql: EntriesSql, fn: () => void): void {
  const tx = sql.transactionSync;
  if (txActive.has(sql)) {
    fn();
    return;
  }
  if (typeof tx !== "function") {
    // SqlStorage has no transactionSync; in the single-threaded DO a fully
    // synchronous sql.exec sequence cannot interleave with other events,
    // so running fn() directly is still atomic with respect to DO work.
    fn();
    return;
  }
  txActive.add(sql);
  try {
    tx.call(sql, fn);
  } finally {
    txActive.delete(sql);
  }
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
  runInSyncTx(sql, () => {
    appendEntry(sql, sid, "prompt", { runId, prompt });
    for (const call of toolCalls) {
      appendEntry(sql, sid, "toolCall", { runId, id: call.id, tool: call.tool, args: call.args });
      appendEntry(sql, sid, "toolResult", { runId, id: call.id, tool: call.tool, output: call.output });
    }
    const resultBody: { runId: string; result: string; usage?: SessionUsage; halt?: SessionHalt } = usage === undefined ? { runId, result } : { runId, result, usage };
    if (halt !== undefined && halt !== null) resultBody.halt = halt;
    appendEntry(sql, sid, "result", resultBody);
    closeRun(sql, sid, runId);
    bumpSessionTotals(sql, sid, usage);
  });
}

export function bumpSessionTotals(sql: EntriesSql, sid: string, usage?: SessionUsage): void {
  const u = usage ?? { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0 };
  sql.exec(
    `INSERT INTO session_totals(sid, inTokens, outTokens, cacheRead, costTotal, elapsedMs, turns) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(sid) DO UPDATE SET
       inTokens = inTokens + excluded.inTokens,
       outTokens = outTokens + excluded.outTokens,
       cacheRead = cacheRead + excluded.cacheRead,
       costTotal = costTotal + excluded.costTotal,
       elapsedMs = elapsedMs + excluded.elapsedMs,
       turns = turns + 1`,
    sid,
    finiteOr0(u.inTokens),
    finiteOr0(u.outTokens),
    finiteOr0(u.cacheRead),
    finiteOr0(u.costTotal),
    finiteOr0(u.elapsedMs),
  );
}

function finiteOr0(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) throw new RangeError(`finiteOr0: negative usage rejected: ${value}`);
  return value;
}

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

function parseResultUsage(body: string): Omit<SessionUsage, "tokensPerSec"> {
  // Timing split staging: per-turn result bodies carry sqlMs/inferenceMs/
  // frameMs as integers >= 0. session_totals gains no columns in this lane
  // (no migration), so totals rows do not aggregate the split; the live
  // per-turn usage payload is the source of truth for the census.
  const zero = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, sqlMs: 0, inferenceMs: 0, frameMs: 0 };
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
    sqlMs: numField(record, "sqlMs"),
    inferenceMs: numField(record, "inferenceMs"),
    frameMs: numField(record, "frameMs"),
    ...("retention" in record && record.retention === "long" ? { retention: "long" as const } : {}),
  };
}

export function sumResultUsage(sql: EntriesSql, sid: string): SessionUsage {
  // No timing columns on session_totals in this lane: sums report a zero
  // split. Per-turn result bodies (parseResultUsage) carry the live split.
  const zeroSplit = { sqlMs: 0, inferenceMs: 0, frameMs: 0 };
  const row = readSingleRow(sql, "SELECT inTokens, outTokens, cacheRead, costTotal, elapsedMs FROM session_totals WHERE sid = ? LIMIT 1", sid);
  if (row === null) return { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null, ...zeroSplit };
  return {
    inTokens: numField(row, "inTokens"),
    outTokens: numField(row, "outTokens"),
    cacheRead: numField(row, "cacheRead"),
    costTotal: numField(row, "costTotal"),
    elapsedMs: numField(row, "elapsedMs"),
    tokensPerSec: null,
    ...zeroSplit,
  };
}

// One-time backfill: totals rows only exist for turns recorded after the
// table landed, so seed from result entries while the table is still empty.
function backfillSessionTotals(sql: EntriesSql): void {
  if (existsBy(sql, "SELECT 1 FROM session_totals LIMIT 1")) return;
  if (!existsBy(sql, "SELECT 1 FROM pi_entries WHERE type = 'result' LIMIT 1")) return;
  runInSyncTx(sql, () => {
    const totals = new Map<string, { inTokens: number; outTokens: number; cacheRead: number; costTotal: number; elapsedMs: number; turns: number }>();
    for (const row of sql.exec("SELECT sid, body FROM pi_entries WHERE type = 'result'")) {
      if (row === null || typeof row !== "object" || !("sid" in row) || typeof row.sid !== "string" || !("body" in row)) continue;
      const usage = parseResultUsage(typeof row.body === "string" ? row.body : "");
      const t = totals.get(row.sid) ?? { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, turns: 0 };
      t.inTokens += usage.inTokens;
      t.outTokens += usage.outTokens;
      t.cacheRead += usage.cacheRead;
      t.costTotal += usage.costTotal;
      t.elapsedMs += usage.elapsedMs;
      t.turns += 1;
      totals.set(row.sid, t);
    }
    for (const [sid, t] of totals) {
      sql.exec(
        "INSERT INTO session_totals(sid, inTokens, outTokens, cacheRead, costTotal, elapsedMs, turns) VALUES (?, ?, ?, ?, ?, ?, ?)",
        sid,
        t.inTokens,
        t.outTokens,
        t.cacheRead,
        t.costTotal,
        t.elapsedMs,
        t.turns,
      );
    }
  });
}

// sessions.leaf defaulted to 0 when the column was added by migration; without
// this fixup appendEntry would restart the parent chain for legacy sessions.
function backfillSessionLeafs(sql: EntriesSql): void {
  sql.exec(
    "UPDATE sessions SET leaf = (SELECT MAX(id) FROM pi_entries WHERE pi_entries.sid = sessions.sid) WHERE leaf = 0 AND EXISTS (SELECT 1 FROM pi_entries WHERE pi_entries.sid = sessions.sid)",
  );
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
