// chunks.ts — per-turn streaming delta mirror.
//
// Every streaming delta emitted through emitEntry lands one row here,
// tagged with the turn's identity plus a per-turn sequence number, so a
// later lane can replay a turn's deltas without scanning pi_entries.
// Writes are synchronous, one per delta; packing is a later phase with
// census numbers. Rows are reaped at compaction cutover (later lane,
// not this wave).
import type { EntriesSql } from "./entries.ts";

export const PI_CHUNKS_DDL =
  "CREATE TABLE IF NOT EXISTS pi_chunks(sid TEXT, turnId TEXT, seq INTEGER, body TEXT, PRIMARY KEY(sid, turnId, seq))";

export function ensureChunksSchema(sql: EntriesSql): void {
  sql.exec(PI_CHUNKS_DDL);
}

export interface ChunkRow {
  sid: string;
  turnId: string;
  seq: number;
  body: string;
}

export function appendChunk(sql: EntriesSql, sid: string, turnId: string, seq: number, body: unknown): void {
  const stored = typeof body === "string" ? body : JSON.stringify(body);
  sql.exec("INSERT INTO pi_chunks(sid, turnId, seq, body) VALUES (?, ?, ?, ?)", sid, turnId, seq, stored);
}

export function listChunksForTurn(sql: EntriesSql, sid: string, turnId: string): ChunkRow[] {
  const out: ChunkRow[] = [];
  for (
    const row of sql.exec(
      "SELECT sid, turnId, seq, body FROM pi_chunks WHERE sid = ? AND turnId = ? ORDER BY seq ASC",
      sid,
      turnId,
    )
  ) {
    if (row === null || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.sid !== "string" || typeof rec.turnId !== "string" || typeof rec.body !== "string") continue;
    if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq)) continue;
    out.push({ sid: rec.sid, turnId: rec.turnId, seq: rec.seq, body: rec.body });
  }
  return out;
}
