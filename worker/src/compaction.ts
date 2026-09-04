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
import { appendEntry, entryHead, listEntries, runInSyncTx, type EntriesSql, type EntryRow } from "../../packages/pi-cf/src/entries";

export const LIVE_ENTRY_BUDGET = 50;
// Reserve under the budget; a freshly compacted table holds
// COMPACTION_KEEP_TAIL plus one summary, which must not re-mark.
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
  sql.exec("CREATE TABLE IF NOT EXISTS compaction_marks(sid TEXT PRIMARY KEY, pending INTEGER NOT NULL DEFAULT 0)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pi_archive(sid TEXT, page INTEGER, entries TEXT, PRIMARY KEY(sid, page))",
  );
}

function isPending(sql: EntriesSql, sid: string): boolean {
  for (const row of sql.exec("SELECT pending FROM compaction_marks WHERE sid = ? LIMIT 1", sid)) {
    if (row !== null && typeof row === "object" && "pending" in row && row.pending === 1) return true;
  }
  return false;
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

// Window-reserve check after a turn commits. Marks but never compacts:
// returns true only on the transition to pending so callers schedule one alarm.
export function maybeMarkForCompaction(sql: EntriesSql, sid: string): boolean {
  const { count } = entryHead(sql, sid);
  if (!shouldCompact(count)) return false;
  if (isPending(sql, sid)) return false;
  sql.exec("INSERT OR REPLACE INTO compaction_marks(sid, pending) VALUES (?, 1)", sid);
  return true;
}

export interface ArchivePage {
  entries: EntryRow[];
  page: number;
  pages: number;
  total: number;
}

export function archiveMeta(sql: EntriesSql, sid: string): { pages: number; total: number } {
  let pages = 0;
  let total = 0;
  for (const row of sql.exec("SELECT COUNT(*) AS pages FROM pi_archive WHERE sid = ?", sid)) {
    if (row !== null && typeof row === "object" && "pages" in row && typeof row.pages === "number") pages = row.pages;
  }
  for (const row of sql.exec("SELECT entries FROM pi_archive WHERE sid = ?", sid)) {
    if (row === null || typeof row !== "object" || !("entries" in row) || typeof row.entries !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(row.entries);
      if (Array.isArray(parsed)) total += parsed.length;
    } catch {
      continue;
    }
  }
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
      if (!Array.isArray(parsed)) continue;
      for (const e of parsed) {
        if (e === null || typeof e !== "object") continue;
        if (!("cursor" in e && "type" in e && "body" in e)) continue;
        if (typeof e.cursor !== "number" || typeof e.type !== "string" || typeof e.body !== "string") continue;
        const parent = "parent" in e && typeof e.parent === "number" ? e.parent : 0;
        entries.push({ cursor: e.cursor, type: e.type, body: e.body, parent });
      }
    } catch {
      continue;
    }
  }
  return { entries, page, pages, total };
}

function readAllLive(sql: EntriesSql, sid: string): EntryRow[] {
  const out: EntryRow[] = [];
  let after = 0;
  for (;;) {
    const slice = listEntries(sql, sid, { after, limit: 1000 });
    if (slice.length === 0) return out;
    out.push(...slice);
    after = slice[slice.length - 1].cursor;
    if (slice.length < 1000) return out;
  }
}
function summarizePrefix(old: EntryRow[]): CompactionSummaryBody {
  let chars = 0;
  const lines: string[] = [];
  for (const e of old) {
    chars += e.body.length;
    if (lines.length >= 8) continue;
    // Chain prior summaries so re-archiving one never drops its content.
    if (e.type === "prompt" || e.type === "result" || e.type === "compaction") {
      try {
        const parsed: unknown = JSON.parse(e.body);
        const text =
          parsed !== null && typeof parsed === "object" && "prompt" in parsed && typeof parsed.prompt === "string"
            ? parsed.prompt
            : parsed !== null && typeof parsed === "object" && "result" in parsed && typeof parsed.result === "string"
              ? parsed.result
              : parsed !== null && typeof parsed === "object" && "summary" in parsed && typeof parsed.summary === "string"
                ? parsed.summary
                : e.body;
        const first = text.split("\n")[0].slice(0, 120);
        if (first.length > 0) lines.push(`${e.type}#${e.cursor}: ${first}`);
      } catch {
        const first = e.body.split("\n")[0].slice(0, 120);
        if (first.length > 0) lines.push(`${e.type}#${e.cursor}: ${first}`);
      }
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
// Same code path for the alarm and the manual route. Deletes nothing the
// archive does not already hold: pages land, the prefix deletes, and the
// summary inserts in one transactionSync (acquire/replace discipline).
export function runCompaction(sql: EntriesSql, sid: string, force = false): CompactionResult {
  const live = readAllLive(sql, sid);
  if (live.length <= COMPACTION_KEEP_TAIL + 1 || (!force && !shouldCompact(live.length))) {
    sql.exec("INSERT OR REPLACE INTO compaction_marks(sid, pending) VALUES (?, 0)", sid);
    return { compacted: false, live: live.length, archived: 0, summaryCursor: null, pages: archiveMeta(sql, sid).pages };
  }
  const cut = live.length - COMPACTION_KEEP_TAIL;
  const old = live.slice(0, cut);
  const body = summarizePrefix(old);
  let summaryCursor = -1;
  runInSyncTx(sql, () => {
    let nextPage = 1;
    for (const row of sql.exec("SELECT COALESCE(MAX(page), 0) AS top FROM pi_archive WHERE sid = ?", sid)) {
      if (row !== null && typeof row === "object" && "top" in row && typeof row.top === "number") nextPage = row.top + 1;
    }
    for (let i = 0; i < old.length; i += ARCHIVE_PAGE_SIZE) {
      sql.exec("INSERT INTO pi_archive(sid, page, entries) VALUES (?, ?, ?)", sid, nextPage++, JSON.stringify(old.slice(i, i + ARCHIVE_PAGE_SIZE)));
    }
    sql.exec("DELETE FROM pi_entries WHERE sid = ? AND id <= ?", sid, body.toCursor);
    summaryCursor = appendEntry(sql, sid, "compaction", body);
    sql.exec("INSERT OR REPLACE INTO compaction_marks(sid, pending) VALUES (?, 0)", sid);
  });
  if (summaryCursor < 0) throw new Error("runCompaction: summary insert returned no cursor");
  const after = entryHead(sql, sid);
  return { compacted: true, live: after.count, archived: old.length, summaryCursor, pages: archiveMeta(sql, sid).pages };
}
