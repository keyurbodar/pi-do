// compaction.ts — bounded live table plus paginated cold archive.
//
// Read-only pattern refs (never imported):
// - refs/pi/packages/coding-agent/src/core/compaction/compaction.ts
//   shouldCompact(contextTokens, contextWindow, settings): headroom under
//   reserveTokens marks the session; summarization never runs inside a turn.
// - refs/pi/packages/agent/src/harness/session/types.ts CompactionEntry:
//   { type: "compaction", summary, retainedTail, tokensBefore }.
// - refs/nanocodex/crates/nanocodex-durability/src/store.rs replace():
//   one atomic compare-and-replace; the archive write below lands in the
//   same transactionSync as the live delete plus summary insert.
//
// Shape: live rows stay in pi_entries with byte-stable cursors (tail ids are
// never rewritten). A compaction moves the old prefix into pi_archive pages
// and leaves one "compaction" summary entry plus the live tail, so resume
// replay equals summary plus tail.
import { advanceSessionLeaf, appendEntry, entryHead, listEntries, runInSyncTx, type EntriesSql, type EntryRow } from "pi-cf/store/entries";
import { CREATE_TABLES, SUMMARY_FIELDS, drainPages, ensureTables, mapEntryRows, parseJsonObject, readScalar, readSingleRow, strField } from "pi-cf/store/sql-util";

export const LIVE_ENTRY_BUDGET = 50;
export const COMPACTION_RESERVE = 24;
export const COMPACTION_KEEP_TAIL = 25;
export const ARCHIVE_PAGE_SIZE = 25;

export function shouldCompact(liveCount: number): boolean {
  return LIVE_ENTRY_BUDGET - liveCount < COMPACTION_RESERVE;
}

export interface CompactionSummaryBody {
  summary: string;
  fromCursor: number;
  toCursor: number;
  count: number;
  tokensBefore: number;
}

export function ensureCompactionSchema(sql: EntriesSql): void {
  ensureTables(sql, [CREATE_TABLES.compactionMarks, CREATE_TABLES.piArchive]);
}

function isPending(sql: EntriesSql, sid: string): boolean {
  const row = readSingleRow(sql, "SELECT pending FROM compaction_marks WHERE sid = ? LIMIT 1", sid);
  return row !== null && row.pending === 1;
}

export function compactionPending(sql: EntriesSql, sid: string): boolean {
  return isPending(sql, sid);
}

export function pendingSessions(sql: EntriesSql): string[] {
  const out: string[] = [];
  for (const row of sql.exec("SELECT sid FROM compaction_marks WHERE pending = 1")) {
    if (row !== null && typeof row === "object" && "sid" in row && typeof row.sid === "string") out.push(row.sid);
  }
  return out;
}

export function maybeMarkForCompaction(sql: EntriesSql, sid: string): boolean {
  const { count } = entryHead(sql, sid);
  if (!shouldCompact(count)) return false;
  if (isPending(sql, sid)) return false;
  sql.exec("INSERT INTO compaction_marks(sid, pending) VALUES (?, 1) ON CONFLICT(sid) DO UPDATE SET pending = 1", sid);
  return true;
}

export interface ArchivePage {
  entries: EntryRow[];
  page: number;
  pages: number;
  total: number;
}

// pages/total live in the compaction_marks row, maintained by runCompaction's
// transaction; rows created before the columns existed undercount until the
// next compaction for that session.
export function archiveMeta(sql: EntriesSql, sid: string): { pages: number; total: number } {
  const row = readSingleRow(sql, "SELECT pages, total FROM compaction_marks WHERE sid = ? LIMIT 1", sid);
  const pages = row !== null && typeof row.pages === "number" ? row.pages : 0;
  const total = row !== null && typeof row.total === "number" ? row.total : 0;
  return { pages, total };
}

export function readArchivePage(sql: EntriesSql, sid: string, page: number): ArchivePage {
  if (!Number.isInteger(page) || page < 1) throw new Error("readArchivePage: page must be a positive integer");
  const { pages, total } = archiveMeta(sql, sid);
  const entries: EntryRow[] = [];
  for (const row of sql.exec("SELECT entries FROM pi_archive WHERE sid = ? AND page = ? LIMIT 1", sid, page)) {
    if (row === null || typeof row !== "object" || !("entries" in row) || typeof row.entries !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(row.entries);
      if (Array.isArray(parsed)) entries.push(...mapEntryRows(parsed));
    } catch {
      continue;
    }
  }
  return { entries, page, pages, total };
}

function readAllLive(sql: EntriesSql, sid: string): EntryRow[] {
  return drainPages((after) => listEntries(sql, sid, { after, limit: 1000 }));
}

function summarizePrefix(old: EntryRow[]): CompactionSummaryBody {
  let chars = 0;
  const lines: string[] = [];
  for (const e of old) {
    chars += e.body.length;
    if (lines.length >= 8) continue;
    if (e.type === "prompt" || e.type === "result" || e.type === "compaction") {
      const obj = parseJsonObject(e.body);
      let text = e.body;
      if (obj !== null) {
        for (const field of SUMMARY_FIELDS) {
          const value = strField(obj, field);
          if (value !== null) {
            text = value;
            break;
          }
        }
      }
      const first = text.split("\n")[0].slice(0, 120);
      if (first.length > 0) lines.push(`${e.type}#${e.cursor}: ${first}`);
    }
  }
  return {
    summary: `compacted ${old.length} entries (cursors ${old[0].cursor}..${old[old.length - 1].cursor}). ${lines.join(" | ")}`,
    fromCursor: old[0].cursor,
    toCursor: old[old.length - 1].cursor,
    count: old.length,
    tokensBefore: Math.ceil(chars / 4),
  };
}

export interface CompactionResult {
  compacted: boolean;
  live: number;
  archived: number;
  summaryCursor: number | null;
  pages: number;
}

export function runCompaction(sql: EntriesSql, sid: string, force = false, liveTurnIds: readonly string[] = []): CompactionResult {
  const live = readAllLive(sql, sid);
  if (live.length <= COMPACTION_KEEP_TAIL + 1 || (!force && !shouldCompact(live.length))) {
    sql.exec("INSERT INTO compaction_marks(sid, pending) VALUES (?, 0) ON CONFLICT(sid) DO UPDATE SET pending = 0", sid);
    return { compacted: false, live: live.length, archived: 0, summaryCursor: null, pages: archiveMeta(sql, sid).pages };
  }
  let cut = live.length - COMPACTION_KEEP_TAIL;
  // Walk the cut back to a turn start so a toolCall/toolResult pair or a
  // prompt/result grouping is never split across the archive boundary.
  while (cut > 0 && (live[cut].type === "toolCall" || live[cut].type === "toolResult" || live[cut].type === "result")) {
    cut -= 1;
  }
  if (cut <= 0) {
    sql.exec("INSERT INTO compaction_marks(sid, pending) VALUES (?, 0) ON CONFLICT(sid) DO UPDATE SET pending = 0", sid);
    return { compacted: false, live: live.length, archived: 0, summaryCursor: null, pages: archiveMeta(sql, sid).pages };
  }
  const old = live.slice(0, cut);
  const tail = live.slice(cut);
  const body = summarizePrefix(old);
  let summaryCursor = -1;
  runInSyncTx(sql, () => {
    const top = readScalar<unknown>(sql, "SELECT COALESCE(MAX(page), 0) AS top FROM pi_archive WHERE sid = ?", sid);
    let nextPage = typeof top === "number" ? top + 1 : 1;
    for (let i = 0; i < old.length; i += ARCHIVE_PAGE_SIZE) {
      sql.exec("INSERT INTO pi_archive(sid, page, entries) VALUES (?, ?, ?)", sid, nextPage++, JSON.stringify(old.slice(i, i + ARCHIVE_PAGE_SIZE)));
    }
    sql.exec("DELETE FROM pi_entries WHERE sid = ? AND id <= ?", sid, body.toCursor);
    // Reap exactly the durability rows the archived prefix covers, same
    // transaction: chunk deltas whose mirrored entry cursor archived, plus
    // ledger rows whose start cursor archived. Excluded: live turns handed
    // in by the caller (a long streaming turn's own early deltas can fall
    // below the cutoff while it still runs), live-tail rows above the
    // cutoff, and chunks without a cursor (predating the column, since NULL
    // never satisfies <=).
    const excluded = liveTurnIds.filter((id) => typeof id === "string" && id.length > 0);
    const keep = excluded.length > 0 ? ` AND turnId NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    sql.exec(`DELETE FROM pi_chunks WHERE sid = ? AND cursor <= ?${keep}`, sid, body.toCursor, ...excluded);
    sql.exec(`DELETE FROM pi_runs WHERE sid = ? AND cursor <= ?${keep}`, sid, body.toCursor, ...excluded);
    summaryCursor = appendEntry(sql, sid, "compaction", body);
    // Re-root the chain: summary -> first tail entry, leaf back on the last
    // tail entry, so the walk from leaf reads tail then summary then stops.
    sql.exec("UPDATE pi_entries SET parent = 0 WHERE sid = ? AND id = ?", sid, summaryCursor);
    sql.exec("UPDATE pi_entries SET parent = ? WHERE sid = ? AND id = ?", summaryCursor, sid, tail[0].cursor);
    advanceSessionLeaf(sql, sid, tail[tail.length - 1].cursor);
    const pages = Math.ceil(old.length / ARCHIVE_PAGE_SIZE);
    sql.exec(
      "INSERT INTO compaction_marks(sid, pending, pages, total) VALUES (?, 0, ?, ?) ON CONFLICT(sid) DO UPDATE SET pending = 0, pages = pages + ?, total = total + ?",
      sid,
      pages,
      old.length,
      pages,
      old.length,
    );
  });
  if (summaryCursor < 0) throw new Error("runCompaction: summary insert returned no cursor");
  const after = entryHead(sql, sid);
  return { compacted: true, live: after.count, archived: old.length, summaryCursor, pages: archiveMeta(sql, sid).pages };
}

// Alarm body helper: compacts every pending session; a failure is recorded as
// an error entry and the alarm is always rescheduled so compaction retries
// instead of stalling the session forever.
export function runPendingCompactions(sql: EntriesSql, reschedule: () => void, liveTurnIds: (sid: string) => readonly string[] = () => []): void {
  for (const sid of pendingSessions(sql)) {
    try {
      runCompaction(sql, sid, false, liveTurnIds(sid));
    } catch (e) {
      appendEntry(sql, sid, "error", { error: e instanceof Error ? e.message : String(e ?? "compaction failed") });
    } finally {
      reschedule();
    }
  }
}
