// entries.ts — sole writer of pi_entries plus the runs open/close ledger.
// Pure functions over a minimal SQL interface; no DO imports, so the same
// logic runs against the DO SqlStorage and the in-memory fake in verify-runs.
import type { SessionUsage } from "./session";

export interface EntriesSql {
  exec(query: string, ...bindings: unknown[]): Iterable<unknown>;
  // Present on DO SqlStorage; absent on the verify fake. Probed, never cast.
  transactionSync?(fn: () => void): void;
}

export interface EntryRow {
  cursor: number;
  parent: number;
  type: string;
  body: string;
}

function tableColumns(sql: EntriesSql, table: string): Set<string> {
  const names = new Set<string>();
  for (const row of sql.exec(`PRAGMA table_info(${table})`)) {
    if (row !== null && typeof row === "object" && "name" in row && typeof row.name === "string") {
      names.add(row.name);
    }
  }
  return names;
}

export function ensureEntriesSchema(sql: EntriesSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pi_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT, sid TEXT, cursor INTEGER, parent INTEGER NOT NULL DEFAULT 0, type TEXT, body TEXT)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS runs (sid TEXT, runId TEXT PRIMARY KEY, status TEXT)",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS pi_entries_sid_id ON pi_entries(sid, id)");
  const entryCols = tableColumns(sql, "pi_entries");
  if (entryCols.size > 0 && !entryCols.has("parent")) {
    sql.exec("ALTER TABLE pi_entries ADD COLUMN parent INTEGER NOT NULL DEFAULT 0");
  }
  const sessionCols = tableColumns(sql, "sessions");
  if (sessionCols.size > 0 && !sessionCols.has("leaf")) {
    sql.exec("ALTER TABLE sessions ADD COLUMN leaf INTEGER NOT NULL DEFAULT 0");
  }
}

export function appendEntry(
  sql: EntriesSql,
  sid: string,
  type: string,
  body: unknown,
): number {
  const stored = typeof body === "string" ? body : JSON.stringify(body);
  let parent = 0;
  for (const row of sql.exec("SELECT COALESCE(MAX(id), 0) AS head FROM pi_entries WHERE sid = ?", sid)) {
    if (row !== null && typeof row === "object" && "head" in row && typeof row.head === "number") {
      parent = row.head;
    }
  }
  sql.exec("INSERT INTO pi_entries(sid, parent, type, body) VALUES (?, ?, ?, ?)", sid, parent, type, stored);
  let cursor = -1;
  for (const row of sql.exec("SELECT last_insert_rowid() AS id")) {
    if (row !== null && typeof row === "object" && "id" in row && typeof row.id === "number") {
      cursor = row.id;
    }
  }
  if (cursor < 0) throw new Error("appendEntry: last_insert_rowid returned no row");
  sql.exec("UPDATE pi_entries SET cursor = ? WHERE id = ?", cursor, cursor);
  advanceSessionLeaf(sql, sid, cursor);
  return cursor;
}

// Session leaf rides the caller's transactionSync when the driver offers
// one, since it is just another exec on the same handle. Old databases
// without the leaf column must not fail the append, so this stays best
// effort outside a migrated schema.
export function advanceSessionLeaf(sql: EntriesSql, sid: string, cursor: number): void {
  try {
    sql.exec("UPDATE sessions SET leaf = ? WHERE sid = ?", cursor, sid);
  } catch {
    // Best effort: sessions predating the leaf migration still accept appends.
  }
}

// Ordered replay slice with resume cursor. limit defaults to 100, clamps at
// 1000, and fails closed (throws) on negative or non-integer input.
export function listEntries(
  sql: EntriesSql,
  sid: string,
  after: number | { after?: number; limit?: number } = 0,
  limit = 100,
): EntryRow[] {
  let a = 0;
  let l = 100;
  if (typeof after === "object" && after !== null) {
    a = after.after ?? 0;
    l = after.limit ?? 100;
  } else {
    a = after;
    l = limit;
  }
  if (!Number.isInteger(a) || a < 0) throw new Error("listEntries: after must be a non-negative integer");
  if (!Number.isInteger(l) || l < 0) throw new Error("listEntries: limit must be a non-negative integer");
  l = Math.min(l, 1000);
  const out: EntryRow[] = [];
  for (const row of sql.exec(
    "SELECT id AS cursor, COALESCE(parent, 0) AS parent, type, body FROM pi_entries WHERE sid = ? AND id > ? ORDER BY id LIMIT ?",
    sid,
    a,
    l,
  )) {
    if (row === null || typeof row !== "object") continue;
    if (!("cursor" in row && "type" in row && "body" in row)) continue;
    if (typeof row.cursor !== "number" || typeof row.type !== "string" || typeof row.body !== "string") continue;
    const parent = "parent" in row && typeof row.parent === "number" ? row.parent : 0;
    out.push({ cursor: row.cursor, type: row.type, body: row.body, parent });
  }
  return out;
}

// Single-row re-read by cursor. Stream frames are built from this, never
// from the in-memory appended copy, so the socket stays a view on storage.
export function getEntry(sql: EntriesSql, sid: string, cursor: number): EntryRow | null {
  for (const row of sql.exec(
    "SELECT id AS cursor, COALESCE(parent, 0) AS parent, type, body FROM pi_entries WHERE sid = ? AND id = ? LIMIT 1",
    sid,
    cursor,
  )) {
    if (row === null || typeof row !== "object") continue;
    if (!("cursor" in row && "type" in row && "body" in row)) continue;
    if (typeof row.cursor !== "number" || typeof row.type !== "string" || typeof row.body !== "string") continue;
    const parent = "parent" in row && typeof row.parent === "number" ? row.parent : 0;
    return { cursor: row.cursor, type: row.type, body: row.body, parent };
  }
  return null;
}

export function entryHead(sql: EntriesSql, sid: string): { count: number; head: number } {
  for (const row of sql.exec(
    "SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS head FROM pi_entries WHERE sid = ?",
    sid,
  )) {
    if (row === null || typeof row !== "object") continue;
    if (!("count" in row && "head" in row)) continue;
    if (typeof row.count !== "number" || typeof row.head !== "number") continue;
    return { count: row.count, head: row.head };
  }
  return { count: 0, head: 0 };
}

export function sessionLeaf(sql: EntriesSql, sid: string): number {
  try {
    for (const row of sql.exec("SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid)) {
      if (row !== null && typeof row === "object" && "leaf" in row && typeof row.leaf === "number" && Number.isInteger(row.leaf) && row.leaf > 0) {
        return row.leaf;
      }
    }
  } catch {
  }
  return entryHead(sql, sid).head;
}

export function runInSyncTx(sql: EntriesSql, fn: () => void): void {
  const tx = sql.transactionSync;
  if (typeof tx === "function") tx.call(sql, fn);
  else fn();
}

// Open a run row; any still-open rows for the sid flip to interrupted and
// each gains an interrupted entry pointing at the superseding run.
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
// Whole turn in order where the driver offers transactionSync; the caller
// either runs openRun before the turn and recordTurn after, or one
// recordTurnWithOpen after, so every entry lands before the response emits.
function recordTurnInner(
  sql: EntriesSql,
  sid: string,
  runId: string,
  prompt: string,
  toolCalls: TurnCall[],
  result: string,
  usage?: SessionUsage,
): void {
  appendEntry(sql, sid, "prompt", { runId, prompt });
  for (const call of toolCalls) {
    appendEntry(sql, sid, "toolCall", { runId, id: call.id, tool: call.tool, args: call.args });
    appendEntry(sql, sid, "toolResult", { runId, id: call.id, tool: call.tool, output: call.output });
  }
  appendEntry(sql, sid, "result", usage === undefined ? { runId, result } : { runId, result, usage });
  closeRun(sql, sid, runId);
}

export function recordTurn(
  sql: EntriesSql,
  sid: string,
  runId: string,
  prompt: string,
  toolCalls: TurnCall[],
  result: string,
  usage?: SessionUsage,
): void {
  runInSyncTx(sql, () => {
    recordTurnInner(sql, sid, runId, prompt, toolCalls, result, usage);
  });
}

// One turn, one commit: the open row plus the turn entries plus the close
// land together. Same rows as openRun followed by recordTurn.
export function recordTurnWithOpen(
  sql: EntriesSql,
  sid: string,
  runId: string,
  prompt: string,
  toolCalls: TurnCall[],
  result: string,
  usage?: SessionUsage,
): void {
  runInSyncTx(sql, () => {
    openRunInner(sql, sid, runId);
    recordTurnInner(sql, sid, runId, prompt, toolCalls, result, usage);
  });
}

// Session usage rollup, summed on read from persisted result entries so no
// new tables are needed. Entries predating usage (or with unreadable bodies)
// count as zeros.
export function sumResultUsage(sql: EntriesSql, sid: string): SessionUsage {
  const sums: SessionUsage = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null };
  let after = 0;
  for (;;) {
    const page = listEntries(sql, sid, { after, limit: 1000 });
    if (page.length === 0) break;
    for (const entry of page) {
      if (entry.type !== "result") continue;
      const usage = parseResultUsage(entry.body);
      sums.inTokens += usage.inTokens;
      sums.outTokens += usage.outTokens;
      sums.cacheRead += usage.cacheRead;
      sums.costTotal += usage.costTotal;
      sums.elapsedMs += usage.elapsedMs;
    }
    after = page[page.length - 1].cursor;
    if (page.length < 1000) break;
  }
  return sums;
}

function parseResultUsage(body: string): Omit<SessionUsage, "tokensPerSec"> {
  const zero = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return zero;
  }
  if (parsed === null || typeof parsed !== "object" || !("usage" in parsed)) return zero;
  const usage = parsed.usage;
  if (usage === null || typeof usage !== "object") return zero;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    inTokens: "inTokens" in usage ? num(usage.inTokens) : 0,
    outTokens: "outTokens" in usage ? num(usage.outTokens) : 0,
    cacheRead: "cacheRead" in usage ? num(usage.cacheRead) : 0,
    costTotal: "costTotal" in usage ? num(usage.costTotal) : 0,
    elapsedMs: "elapsedMs" in usage ? num(usage.elapsedMs) : 0,
    ...("retention" in usage && usage.retention === "long" ? { retention: "long" as const } : {}),
  };
}

export interface SessionUsageMeta extends SessionUsage {
  contextPct: number | null;
  hitPct: number;
}

// Session rates over summed usage, same 100ms floor as the per-turn rate.
export function withSessionRates(sums: SessionUsage, contextWindow: number | null): SessionUsageMeta {
  const tokensPerSec = sums.outTokens > 0 && sums.elapsedMs >= 100 ? (sums.outTokens * 1000) / sums.elapsedMs : null;
  const context = sums.inTokens + sums.outTokens + sums.cacheRead;
  const contextPct = typeof contextWindow === "number" && contextWindow > 0 ? (context / contextWindow) * 100 : null;
  const hitDenom = sums.inTokens + sums.cacheRead;
  return { ...sums, tokensPerSec, contextPct, hitPct: hitDenom > 0 ? (sums.cacheRead / hitDenom) * 100 : 0 };
}
