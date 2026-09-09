// chunks.ts — per-turn streaming delta mirror.
//
// Every streaming delta emitted through emitEntry lands one row here,
// tagged with the turn's identity plus a per-turn sequence number, so a
// later lane can replay a turn's deltas without scanning pi_entries. The
// cursor column pins each delta to the entry row it mirrored, so the
// compaction cutover can reap exactly the archived prefix. Writes are
// synchronous, one per delta; packing is a later phase with census numbers.
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
