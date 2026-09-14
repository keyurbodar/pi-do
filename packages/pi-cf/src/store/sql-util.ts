export interface Sql {
  exec(query: string, ...bindings: unknown[]): Iterable<unknown>;
}

export interface EntryRow {
  cursor: number;
  parent: number;
  type: string;
  body: string;
}

export function parseJsonObject(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export function strField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

export function numField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readSingleRow(sql: Sql, query: string, ...bindings: unknown[]): Record<string, unknown> | null {
  for (const row of sql.exec(query, ...bindings)) {
    if (row !== null && typeof row === "object") return row as Record<string, unknown>;
  }
  return null;
}

export function readScalar<T>(sql: Sql, query: string, ...bindings: unknown[]): T | undefined {
  const row = readSingleRow(sql, query, ...bindings);
  if (row === null) return undefined;
  const values = Object.values(row);
  return (values.length > 0 ? values[0] : undefined) as T | undefined;
}

export function toEntryRow(row: unknown): EntryRow | null {
  if (row === null || typeof row !== "object") return null;
  if (!("cursor" in row && "type" in row && "body" in row)) return null;
  if (typeof row.cursor !== "number" || typeof row.type !== "string" || typeof row.body !== "string") return null;
  return { cursor: row.cursor, type: row.type, body: row.body, parent: "parent" in row && typeof row.parent === "number" ? row.parent : 0 };
}

export function mapEntryRows(rows: Iterable<unknown>): EntryRow[] {
  const out: EntryRow[] = [];
  for (const row of rows) {
    const entry = toEntryRow(row);
    if (entry !== null) out.push(entry);
  }
  return out;
}

export function existsBy(sql: Sql, query: string, ...bindings: unknown[]): boolean {
  for (const row of sql.exec(query, ...bindings)) {
    void row;
    return true;
  }
  return false;
}

export function drainPages<T extends { cursor: number }>(fetchPage: (after: number) => T[]): T[] {
  const out: T[] = [];
  let after = 0;
  for (;;) {
    const page = fetchPage(after);
    if (page.length === 0) return out;
    out.push(...page);
    after = page[page.length - 1].cursor;
    if (page.length < 1000) return out;
  }
}

function tableColumns(sql: Sql, table: string): Set<string> {
  const names = new Set<string>();
  for (const row of sql.exec(`PRAGMA table_info(${table})`)) {
    if (row !== null && typeof row === "object" && "name" in row && typeof row.name === "string") {
      names.add(row.name);
    }
  }
  return names;
}

export interface Migration {
  table: string;
  column: string;
  ddl: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { table: "pi_entries", column: "parent", ddl: "ALTER TABLE pi_entries ADD COLUMN parent INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "ownerFence", ddl: "ALTER TABLE sessions ADD COLUMN ownerFence TEXT" },
  { table: "sessions", column: "revision", ddl: "ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "modelProvider", ddl: "ALTER TABLE sessions ADD COLUMN modelProvider TEXT" },
  { table: "sessions", column: "modelId", ddl: "ALTER TABLE sessions ADD COLUMN modelId TEXT" },
  { table: "sessions", column: "thinkingLevel", ddl: "ALTER TABLE sessions ADD COLUMN thinkingLevel TEXT" },
  { table: "sessions", column: "cacheRetention", ddl: "ALTER TABLE sessions ADD COLUMN cacheRetention TEXT" },
  { table: "sessions", column: "backstory", ddl: "ALTER TABLE sessions ADD COLUMN backstory TEXT" },
  { table: "sessions", column: "leaf", ddl: "ALTER TABLE sessions ADD COLUMN leaf INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "name", ddl: "ALTER TABLE sessions ADD COLUMN name TEXT" },
  { table: "sessions", column: "cwd", ddl: "ALTER TABLE sessions ADD COLUMN cwd TEXT" },
  { table: "sessions", column: "parentSessionId", ddl: "ALTER TABLE sessions ADD COLUMN parentSessionId TEXT" },
  { table: "sessions", column: "deleted_at", ddl: "ALTER TABLE sessions ADD COLUMN deleted_at TEXT" },
  { table: "compaction_marks", column: "pages", ddl: "ALTER TABLE compaction_marks ADD COLUMN pages INTEGER NOT NULL DEFAULT 0" },
  { table: "compaction_marks", column: "total", ddl: "ALTER TABLE compaction_marks ADD COLUMN total INTEGER NOT NULL DEFAULT 0" },
];

export function migrate(sql: Sql, migrations: readonly Migration[] = MIGRATIONS): void {
  for (const m of migrations) {
    const cols = tableColumns(sql, m.table);
    if (cols.size > 0 && !cols.has(m.column)) sql.exec(m.ddl);
  }
}

export const CREATE_TABLES = {
  workspaces: "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, created_at TEXT)",
  sessions: "CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, ws TEXT, created_at TEXT, ownerFence TEXT, revision INTEGER NOT NULL DEFAULT 0, name TEXT, cwd TEXT, parentSessionId TEXT)",
  workspaceSettings: "CREATE TABLE IF NOT EXISTS workspace_settings(ws TEXT PRIMARY KEY, modelProvider TEXT, modelId TEXT, thinkingLevel TEXT)",
  piEntries: "CREATE TABLE IF NOT EXISTS pi_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT, sid TEXT, cursor INTEGER, parent INTEGER NOT NULL DEFAULT 0, type TEXT, body TEXT)",
  runs: "CREATE TABLE IF NOT EXISTS runs (sid TEXT, runId TEXT PRIMARY KEY, status TEXT)",
  piEntriesSidId: "CREATE INDEX IF NOT EXISTS pi_entries_sid_id ON pi_entries(sid, id)",
  compactionMarks: "CREATE TABLE IF NOT EXISTS compaction_marks(sid TEXT PRIMARY KEY, pending INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0)",
  sessionTotals: "CREATE TABLE IF NOT EXISTS session_totals(sid TEXT PRIMARY KEY, inTokens INTEGER NOT NULL DEFAULT 0, outTokens INTEGER NOT NULL DEFAULT 0, cacheRead INTEGER NOT NULL DEFAULT 0, costTotal REAL NOT NULL DEFAULT 0, elapsedMs INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0)",
  files: "CREATE TABLE IF NOT EXISTS files(ws TEXT, path TEXT, body BLOB, updated_at TEXT, PRIMARY KEY(ws, path))",
  piArchive: "CREATE TABLE IF NOT EXISTS pi_archive(sid TEXT, page INTEGER, entries TEXT, PRIMARY KEY(sid, page))",
  piRoutines: "CREATE TABLE IF NOT EXISTS pi_routines(ws TEXT, id TEXT PRIMARY KEY, sid TEXT, schedule_kind TEXT, schedule_spec TEXT, prompt TEXT, next_run_at INTEGER, expire_at INTEGER, max_runs INTEGER, run_count INTEGER NOT NULL DEFAULT 0, min_interval_s INTEGER, created_by TEXT, last_request_id TEXT, claim_epoch INTEGER NOT NULL DEFAULT 0)",
  piInbox: "CREATE TABLE IF NOT EXISTS pi_inbox(ws TEXT, id TEXT PRIMARY KEY, thread TEXT, from_sid TEXT NOT NULL, to_sid TEXT NOT NULL, body TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL, delivered_at TEXT, outcome_cursor INTEGER, queued_at INTEGER)",
  piGroups: "CREATE TABLE IF NOT EXISTS pi_groups(ws TEXT, id TEXT PRIMARY KEY, name TEXT, thread TEXT NOT NULL, created_at TEXT NOT NULL)",
  piGroupMembers: "CREATE TABLE IF NOT EXISTS pi_group_members(ws TEXT, group_id TEXT, sid TEXT, PRIMARY KEY(ws, group_id, sid))",
} as const;

export function ensureTables(sql: Sql, tables: readonly string[] = Object.values(CREATE_TABLES)): void {
  for (const ddl of tables) sql.exec(ddl);
  migrate(sql);
}

export function ensureWorkspaceSchema(sql: Sql): void {
  ensureTables(sql, [CREATE_TABLES.workspaces, CREATE_TABLES.sessions, CREATE_TABLES.workspaceSettings]);
}

export const FILES_QUERIES = {
  put: "INSERT OR REPLACE INTO files(ws, path, body, updated_at) VALUES (?, ?, ?, ?)",
  get: "SELECT body FROM files WHERE ws = ? AND path = ?",
  list: "SELECT path, length(body) AS bytes FROM files WHERE ws = ? AND path LIKE (? || '%') ORDER BY path",
  exists: "SELECT 1 FROM files WHERE ws = ? AND path = ? LIMIT 1",
  remove: "DELETE FROM files WHERE ws = ? AND path = ?",
  listPaths: "SELECT path FROM files WHERE ws = ? AND path LIKE (? || '%') ORDER BY path",
  deleteByPrefix: "DELETE FROM files WHERE ws = ? AND path LIKE (? || '%')",
} as const;

export interface EntryProjection {
  field: string;
  role: string;
  withArgs?: boolean;
}

export const ENTRY_PROJECTION: Record<string, EntryProjection> = {
  prompt: { field: "prompt", role: "user" },
  result: { field: "result", role: "assistant" },
  toolCall: { field: "tool", role: "toolCall", withArgs: true },
  toolResult: { field: "output", role: "toolResult" },
  compaction: { field: "summary", role: "compactionSummary" },
  steer: { field: "text", role: "user" },
};

export const SUMMARY_FIELDS: readonly string[] = ["prompt", "result", "summary"];
