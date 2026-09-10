import { drainPages, readSingleRow } from "./sql-util.ts";
import { advanceSessionLeaf, appendEntry, entryHead, listEntries, type EntriesSql } from "./entries.ts";

export interface CheckpointRow {
  checkpointId: string;
  sid: string;
  cursor: number;
  label: string | null;
  created: string;
}

export function ensureCheckpointsSchema(sql: EntriesSql): void {
  sql.exec("CREATE TABLE IF NOT EXISTS checkpoints(sid TEXT, checkpointId TEXT PRIMARY KEY, cursor INTEGER NOT NULL, label TEXT, created_at TEXT)");
}

// Lineage walk over the wt-schema contract: newest session first, capped
// against a corrupt cycle, nulls and missing rows end the chain.
export function readLineage(sql: EntriesSql, sid: string): string[] {
  const out: string[] = [];
  let cur: string | null = sid;
  for (let i = 0; i < 100 && cur !== null; i += 1) {
    out.push(cur);
    const row = readSingleRow(sql, "SELECT parentSessionId FROM sessions WHERE sid = ?", cur);
    const parent = row === null ? undefined : row.parentSessionId;
    cur = typeof parent === "string" && parent.length > 0 ? parent : null;
  }
  return out;
}

function toCheckpointRow(row: Record<string, unknown>, sid: string): CheckpointRow | null {
  if (typeof row.checkpointId !== "string" || typeof row.cursor !== "number" || !Number.isInteger(row.cursor)) return null;
  return {
    checkpointId: row.checkpointId,
    sid,
    cursor: row.cursor,
    label: typeof row.label === "string" ? row.label : null,
    created: typeof row.created_at === "string" ? row.created_at : "",
  };
}

export function createCheckpoint(sql: EntriesSql, sid: string, checkpointId: string, cursor: number, label: string | null): CheckpointRow {
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw { error: "checkpoint_bad_cursor", hint: "retry with cursor 0 or an entry cursor of this session" };
  }
  if (cursor > 0) {
    const probe = listEntries(sql, sid, { after: cursor - 1, limit: 1 });
    if (probe.length === 0 || probe[0].cursor !== cursor) {
      throw { error: "checkpoint_bad_cursor", hint: "retry with cursor 0 or an entry cursor of this session" };
    }
  }
  const created = new Date().toISOString();
  sql.exec(
    "INSERT INTO checkpoints(sid, checkpointId, cursor, label, created_at) VALUES (?, ?, ?, ?, ?)",
    sid,
    checkpointId,
    cursor,
    label,
    created,
  );
  return { checkpointId, sid, cursor, label, created };
}
export function listCheckpoints(sql: EntriesSql, sid: string): CheckpointRow[] {
  const out: CheckpointRow[] = [];
  for (const row of sql.exec("SELECT checkpointId, cursor, label, created_at FROM checkpoints WHERE sid = ? ORDER BY rowid", sid)) {
    if (row !== null && typeof row === "object") {
      const parsed = toCheckpointRow(row as Record<string, unknown>, sid);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

export function getCheckpoint(sql: EntriesSql, sid: string, checkpointId: string): CheckpointRow | null {
  const row = readSingleRow(sql, "SELECT checkpointId, cursor, label, created_at FROM checkpoints WHERE sid = ? AND checkpointId = ? LIMIT 1", sid, checkpointId);
  return row === null ? null : toCheckpointRow(row, sid);
}

export interface RewindResult {
  sid: string;
  cursor: number;
  leaf: number;
  abandoned: { from: number | null; to: number | null; count: number; types: Record<string, number> };
  summaryCursor: number | null;
  lineage: string[];
}

// Rewind moves the leaf back to cursor and commits one branch-summary entry
// over the abandoned tail so the undone branch stays readable. The tail rows
// are kept: the chain walks leaf -> summary -> cursor, never the tail.
export function rewindSession(sql: EntriesSql, sid: string, cursor: number): RewindResult {
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw { error: "checkpoint_bad_cursor", hint: "retry with cursor 0 or an entry cursor of this session" };
  }
  if (cursor > 0) {
    const probe = listEntries(sql, sid, { after: cursor - 1, limit: 1 });
    if (probe.length === 0 || probe[0].cursor !== cursor) {
      throw { error: "checkpoint_bad_cursor", hint: "retry with cursor 0 or an entry cursor of this session" };
    }
  }
  // Any live entry of this session is a valid target: everything after it
  // is summarized as the abandoned branch, so rewind never moves forward
  // and needs no ahead/behind gate beyond the existence probe above.
  const tail = drainPages((after) => listEntries(sql, sid, { after: Math.max(after, cursor), limit: 1000 }));
  const types: Record<string, number> = {};
  for (const e of tail) types[e.type] = (types[e.type] ?? 0) + 1;
  const lineage = readLineage(sql, sid);
  let summaryCursor: number | null = null;
  if (tail.length > 0) {
    const { head } = entryHead(sql, sid);
    advanceSessionLeaf(sql, sid, cursor);
    summaryCursor = appendEntry(sql, sid, "branch-summary", {
      cursor,
      abandoned: { from: tail[0].cursor, to: head, count: tail.length, types },
      lineage,
    });
  }
  return {
    sid,
    cursor,
    leaf: summaryCursor ?? cursor,
    abandoned: {
      from: tail.length > 0 ? tail[0].cursor : null,
      to: tail.length > 0 ? tail[tail.length - 1].cursor : null,
      count: tail.length,
      types,
    },
    summaryCursor,
    lineage,
  };
}
