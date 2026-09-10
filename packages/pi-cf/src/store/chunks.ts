// chunks.ts — per-turn streaming delta mirror.
//
// Every streaming delta emitted through emitEntry lands one row here,
// tagged with the turn's identity plus a per-turn sequence number, so a
// later lane can replay a turn's deltas without scanning pi_entries. The
// cursor column pins each delta to the entry row it mirrored, so the
// compaction cutover can reap exactly the archived prefix. Writes are
// synchronous: free-text deltas pack into boundary-aware multi-row flushes
// while structural deltas keep one row per delta with identical shape.
import type { EntriesSql } from "./entries.ts";

export const PI_CHUNKS_DDL =
  "CREATE TABLE IF NOT EXISTS pi_chunks(sid TEXT, turnId TEXT, seq INTEGER, body TEXT, cursor INTEGER, PRIMARY KEY(sid, turnId, seq))";

export const PI_CHUNKS_SID_CURSOR_INDEX = "CREATE INDEX IF NOT EXISTS pi_chunks_sid_cursor ON pi_chunks(sid, cursor)";

export function ensureChunksSchema(sql: EntriesSql): void {
  sql.exec(PI_CHUNKS_DDL);
  // Pre-migration tables lack the column; tolerate the duplicate-column
  // error so ensure stays idempotent on already-migrated stores.
  try {
    sql.exec("ALTER TABLE pi_chunks ADD COLUMN cursor INTEGER");
  } catch (e) {
    const text = e instanceof Error ? e.message : String((e as { error?: unknown } | null)?.error ?? e);
    if (!/duplicate column/i.test(text)) throw e;
  }
  sql.exec(PI_CHUNKS_SID_CURSOR_INDEX);
}

export interface ChunkRow {
  sid: string;
  turnId: string;
  seq: number;
  body: string;
  // Mirrored entry cursor, null on pre-migration rows. Non-null pins a
  // committed entry: chunk and entry land in one transaction, and archiving
  // reaps both together, so a surviving pin always resolves.
  cursor: number | null;
}

export function appendChunk(sql: EntriesSql, sid: string, turnId: string, seq: number, body: unknown, cursor?: number | null): void {
  const stored = typeof body === "string" ? body : JSON.stringify(body);
  sql.exec("INSERT INTO pi_chunks(sid, turnId, seq, body, cursor) VALUES (?, ?, ?, ?, ?)", sid, turnId, seq, stored, cursor ?? null);
}

// One buffered delta awaiting a boundary flush. Body is stored serialized
// (same shape appendChunk writes) so the flush is a pure multi-row INSERT
// with no re-serialization, and bytes are exact for the flush budget.
export interface BufferedChunk {
  seq: number;
  body: string;
  cursor: number | null;
}

export function serializeChunkBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

// Boundary-aware flush: packs every buffered delta for the turn into one
// multi-row INSERT instead of one INSERT per delta. Row shape is identical
// to appendChunk rows (same PK, same cursor pins), so the recovery scan,
// the redrive skip math, and the compaction reaping read packed rows
// exactly like per-delta rows.
export function appendChunkBatch(sql: EntriesSql, sid: string, turnId: string, rows: readonly BufferedChunk[]): void {
  if (rows.length === 0) return;
  if (rows.length === 1) {
    const only = rows[0];
    sql.exec("INSERT INTO pi_chunks(sid, turnId, seq, body, cursor) VALUES (?, ?, ?, ?, ?)", sid, turnId, only.seq, only.body, only.cursor);
    return;
  }
  const placeholders = rows.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const bindings: unknown[] = [];
  for (const row of rows) bindings.push(sid, turnId, row.seq, row.body, row.cursor);
  sql.exec(`INSERT INTO pi_chunks(sid, turnId, seq, body, cursor) VALUES ${placeholders}`, ...bindings);
}

export function listChunksForTurn(sql: EntriesSql, sid: string, turnId: string): ChunkRow[] {
  const out: ChunkRow[] = [];
  for (
    const row of sql.exec(
      "SELECT sid, turnId, seq, body, cursor FROM pi_chunks WHERE sid = ? AND turnId = ? ORDER BY seq ASC",
      sid,
      turnId,
    )
  ) {
    if (row === null || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.sid !== "string" || typeof rec.turnId !== "string" || typeof rec.body !== "string") continue;
    if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq)) continue;
    out.push({ sid: rec.sid, turnId: rec.turnId, seq: rec.seq, body: rec.body, cursor: typeof rec.cursor === "number" ? rec.cursor : null });
  }
  return out;
}
