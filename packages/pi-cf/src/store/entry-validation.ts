import { drainPages, parseJsonObject, readSingleRow } from "./sql-util.ts";
import { entryHead, listEntries, type EntriesSql } from "./entries.ts";

// Write-path guard for appendEntry: every corruption class rejects with a
// named error before any INSERT runs, never coerced into a stored row.
export function checkEntry(sql: EntriesSql, sid: string, type: string, body: unknown): void {
  checkSerializable(body);
  checkDuplicateId(sql, sid, type, body);
  checkChain(sql, sid);
}

// JSON round-trip must succeed and produce a string: stringify throws on
// circular/BigInt and returns undefined for undefined/functions/symbols.
function checkSerializable(body: unknown): void {
  if (typeof body === "string") return;
  let stored: unknown;
  try {
    stored = JSON.stringify(body);
  } catch {
    stored = undefined;
  }
  if (typeof stored !== "string") {
    throw {
      error: "entry_body_not_serializable",
      hint: "retry with a JSON-serializable body: plain objects, arrays, strings, numbers, booleans, or null",
    };
  }
}

// Tool halves share their call id across types by design, and stub redrives
// reuse session-N ids across turns, so duplicates are scoped to one
// (type, runId, id) triple: a second commit of the same half is corruption.
function checkDuplicateId(sql: EntriesSql, sid: string, type: string, body: unknown): void {
  if (body === null || typeof body !== "object") return;
  const rec = body as Record<string, unknown>;
  if (typeof rec.runId !== "string" || typeof rec.id !== "string") return;
  const rows = drainPages((after) => listEntries(sql, sid, { after, limit: 1000 }));
  for (const row of rows) {
    if (row.type !== type) continue;
    const prior = parseJsonObject(row.body);
    if (prior !== null && prior.runId === rec.runId && prior.id === rec.id) {
      throw {
        error: "entry_duplicate_id",
        hint: `a ${type} entry with id ${rec.id} is already recorded for this run; retry with a fresh id, never re-commit the same half`,
      };
    }
  }
}

// The new entry chains onto the session leaf, so the leaf must resolve to a
// live row of this session: post-compaction the leaf sits on the tail (below
// head), legacy rows read 0 and fall back to head exactly like sessionLeaf.
function checkChain(sql: EntriesSql, sid: string): void {
  const leafRow = readSingleRow(sql, "SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid);
  const leaf = leafRow === null ? undefined : leafRow.leaf;
  const { count, head } = entryHead(sql, sid);
  if (count === 0) {
    if (typeof leaf === "number" && leaf > 0) {
      throw {
        error: "entry_chain_broken",
        hint: "sessions.leaf points at no entry of this session; inspect the leaf before appending",
      };
    }
    return;
  }
  const anchor = typeof leaf === "number" && Number.isInteger(leaf) && leaf > 0 ? leaf : head;
  const probe = listEntries(sql, sid, { after: anchor - 1, limit: 1 });
  if (probe.length === 0 || probe[0].cursor !== anchor) {
    throw {
      error: "entry_chain_broken",
      hint: "sessions.leaf points outside this session's entries; inspect the leaf before appending",
    };
  }
}
