// entries.ts — sole writer of pi_entries plus the runs open/close ledger.
// Pure functions over a minimal SQL interface; no DO imports, so the same
// logic runs against the DO SqlStorage and the in-memory fake in verify-runs.

export interface EntriesSql {
  exec(query: string, ...bindings: unknown[]): Iterable<unknown>;
  // Present on DO SqlStorage; absent on the verify fake. Probed, never cast.
  transactionSync?(fn: () => void): void;
}

export interface EntryRow {
  cursor: number;
  type: string;
  body: string;
}

export function ensureEntriesSchema(sql: EntriesSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pi_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT, sid TEXT, cursor INTEGER, type TEXT, body TEXT)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS runs (sid TEXT, runId TEXT PRIMARY KEY, status TEXT)",
  );
}

export function appendEntry(
  sql: EntriesSql,
  sid: string,
  type: string,
  body: unknown,
): number {
  const stored = typeof body === "string" ? body : JSON.stringify(body);
  sql.exec("INSERT INTO pi_entries(sid, type, body) VALUES (?, ?, ?)", sid, type, stored);
  let cursor = -1;
  for (const row of sql.exec("SELECT last_insert_rowid() AS id")) {
    if (row !== null && typeof row === "object" && "id" in row && typeof row.id === "number") {
      cursor = row.id;
    }
  }
  if (cursor < 0) throw new Error("appendEntry: last_insert_rowid returned no row");
  sql.exec("UPDATE pi_entries SET cursor = ? WHERE id = ?", cursor, cursor);
  return cursor;
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
    "SELECT id AS cursor, type, body FROM pi_entries WHERE sid = ? AND id > ? ORDER BY id LIMIT ?",
    sid,
    a,
    l,
  )) {
    if (row === null || typeof row !== "object") continue;
    if (!("cursor" in row && "type" in row && "body" in row)) continue;
    if (typeof row.cursor !== "number" || typeof row.type !== "string" || typeof row.body !== "string") continue;
    out.push({ cursor: row.cursor, type: row.type, body: row.body });
  }
  return out;
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

export function runInSyncTx(sql: EntriesSql, fn: () => void): void {
  const tx = sql.transactionSync;
  if (typeof tx === "function") tx.call(sql, fn);
  else fn();
}

// Open a run row; any still-open rows for the sid flip to interrupted and
// each gains an interrupted entry pointing at the superseding run.
export function openRun(sql: EntriesSql, sid: string, runId: string): void {
  runInSyncTx(sql, () => {
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

// Whole turn in order inside one sync transaction where the driver offers
// transactionSync; the caller runs openRun before the turn and recordTurn
// after, so every entry lands before the response is emitted.
export function recordTurn(
  sql: EntriesSql,
  sid: string,
  runId: string,
  prompt: string,
  toolCalls: TurnCall[],
  result: string,
): void {
  runInSyncTx(sql, () => {
    appendEntry(sql, sid, "prompt", { runId, prompt });
    for (const call of toolCalls) {
      appendEntry(sql, sid, "toolCall", { runId, id: call.id, tool: call.tool, args: call.args });
      appendEntry(sql, sid, "toolResult", { runId, id: call.id, tool: call.tool, output: call.output });
    }
    appendEntry(sql, sid, "result", { runId, result });
    closeRun(sql, sid, runId);
  });
}
