import type { EntriesSql, EntryRow } from "../store/entries.ts";
import { projectEntry } from "./projectors.ts";
import { parseJsonObject, readSingleRow, strField } from "../store/sql-util.ts";
import { loadProjectContextMessage, type ProjectContextSource } from "./project-context.ts";
export type ContextRole = "user" | "assistant" | "compactionSummary" | "toolCall" | "toolResult";

export interface ContextMessage {
  role: ContextRole;
  text: string;
  cursor: number;
}

export interface SkippedEntry {
  cursor: number;
  type: string;
  reason: string;
}

export interface SessionContext {
  messages: ContextMessage[];
  model: { provider: string; id: string } | null;
  thinking: string;
  toolNames: string[] | null;
  skipped: SkippedEntry[];
  truncated: boolean;
  dropped: number;
}

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function capSessionContext(ctx: SessionContext, budgetTokens: number): SessionContext {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return ctx;
  }
  const summaries = ctx.messages.filter((message) => message.role === "compactionSummary");
  const summaryTokens = summaries.reduce((total, message) => total + estimateTokens(message.text), 0);
  if (summaryTokens > budgetTokens) {
    return {
      messages: [...summaries],
      model: ctx.model,
      thinking: ctx.thinking,
      toolNames: ctx.toolNames,
      skipped: ctx.skipped,
      truncated: true,
      dropped: ctx.messages.length - summaries.length,
    };
  }
  const kept = [...ctx.messages];
  let total = kept.reduce((sum, message) => sum + estimateTokens(message.text), 0);
  let dropped = 0;
  // A group is one prompt plus everything up to its result (toolCall/toolResult
  // pairs, mid-turn steers). Trimming drops whole groups so a pair or a
  // prompt/result grouping is never split.
  const groups: ContextMessage[][] = [];
  let open = false;
  for (const message of kept) {
    if (message.role === "user" && !open) {
      groups.push([message]);
      open = true;
    } else if (message.role === "compactionSummary") {
      groups.push([message]);
      open = false;
    } else if (groups.length === 0) {
      groups.push([message]);
    } else {
      groups[groups.length - 1].push(message);
      if (message.role === "assistant") open = false;
    }
  }
  while (total > budgetTokens) {
    const groupIndex = groups.findIndex((group) => !group.some((message) => message.role === "compactionSummary"));
    if (groupIndex === -1) {
      break;
    }
    for (const message of groups[groupIndex]) {
      total -= estimateTokens(message.text);
    }
    dropped += groups[groupIndex].length;
    groups.splice(groupIndex, 1);
  }
  const messages = groups.flat();
  return {
    messages,
    model: ctx.model,
    thinking: ctx.thinking,
    toolNames: ctx.toolNames,
    skipped: ctx.skipped,
    truncated: dropped > 0,
    dropped,
  };
}

export type EntryReader = (cursor: number) => EntryRow | null;

export function buildSessionContext(leaf: number, readEntry: EntryReader, project?: ProjectContextSource | null): SessionContext {
  const context: SessionContext = { messages: [], model: null, thinking: "off", toolNames: null, skipped: [], truncated: false, dropped: 0 };
  const section = project === undefined || project === null ? null : loadProjectContextMessage(project);
  if (section !== null) context.messages.push(section);
  if (!Number.isInteger(leaf) || leaf <= 0) {
    return context;
  }
  const chain: EntryRow[] = [];
  const seen = new Set<number>();
  const byCursor = new Map<number, EntryRow>();
  let cycle: SkippedEntry | null = null;
  let cursor = leaf;
  while (Number.isInteger(cursor) && cursor > 0) {
    const entry = readEntry(cursor);
    if (entry === null || entry === undefined) {
      break;
    }
    const key = typeof entry.cursor === "number" ? entry.cursor : cursor;
    if (seen.has(cursor) || seen.has(key)) {
      const dup = byCursor.get(key) ?? byCursor.get(cursor);
      cycle = { cursor: key, type: dup === undefined ? entry.type : dup.type, reason: "parent-cycle" };
      break;
    }
    seen.add(cursor);
    seen.add(key);
    chain.push(entry);
    byCursor.set(cursor, entry);
    byCursor.set(key, entry);
    const parent: unknown = entry.parent;
    if (typeof parent !== "number" || !Number.isInteger(parent) || parent <= 0) {
      break;
    }
    cursor = parent;
  }
  if (chain.length === 0) {
    return context;
  }
  chain.reverse();
  if (cycle !== null) {
    context.skipped.push(cycle);
  }
  let windowStart = 0;
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].type === "compaction") {
      windowStart = i;
    }
  }
  for (const entry of chain) {
    if (entry.type === "thinking_level_change") {
      const obj = parseJsonObject(entry.body);
      const level = obj === null ? null : strField(obj, "level");
      if (level === null) {
        context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
      } else {
        context.thinking = level;
      }
    } else if (entry.type === "model_change") {
      const obj = parseJsonObject(entry.body);
      const to = obj === null ? null : obj["to"];
      const record = to !== null && typeof to === "object" && !Array.isArray(to) ? (to as Record<string, unknown>) : null;
      const provider = record === null ? null : strField(record, "provider");
      const id = record === null ? null : strField(record, "id");
      if (provider === null || id === null) {
        context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
      } else {
        context.model = { provider, id };
      }
    }
  }
  for (let i = windowStart; i < chain.length; i++) {
    const entry = chain[i];
    if (entry.type === "thinking_level_change" || entry.type === "model_change") continue;
    const proj = projectEntry(entry.type);
    if (proj === undefined) {
      context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unprojected" });
      continue;
    }
    const obj = parseJsonObject(entry.body);
    const value = obj === null ? null : strField(obj, proj.field);
    if (value === null) {
      context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
      continue;
    }
    const args = obj === null ? undefined : obj["args"];
    const text = proj.withArgs === true && args !== null && typeof args === "object" ? `${value} ${JSON.stringify(args)}` : value;
    context.messages.push({ role: proj.role as ContextRole, text, cursor: entry.cursor });
  }
  return context;
}

export function buildSessionContextFromEntries(entries: readonly EntryRow[], leaf: number, project?: ProjectContextSource | null): SessionContext {
  const byCursor = new Map<number, EntryRow>();
  for (const entry of entries) {
    byCursor.set(entry.cursor, entry);
  }
  return buildSessionContext(leaf, (cursor) => byCursor.get(cursor) ?? null, project);
}

export type BranchEntryReader = (sessionId: string) => EntryRow[];

// Root-first session lineage via parentSessionId. An absent column throws
// BLOCKED naming parentSessionId instead of inferring lineage from entries.
export function sessionLineage(sql: EntriesSql, sid: string): string[] {
  const chain: string[] = [sid];
  let current = sid;
  for (;;) {
    let parent: unknown = null;
    try {
      const row = readSingleRow(sql, "SELECT parentSessionId FROM sessions WHERE sid = ? LIMIT 1", current);
      parent = row === null ? null : row.parentSessionId;
    } catch (e) {
      if (e instanceof Error && /no such column:?\s*parentSessionId/i.test(e.message)) {
        throw new Error("branch reads BLOCKED: sessions.parentSessionId column absent; refusing to infer lineage from entries");
      }
      throw e;
    }
    if (typeof parent !== "string" || parent.length === 0 || chain.includes(parent)) return chain.reverse();
    chain.push(parent);
    current = parent;
  }
}

// Branch-scoped reads: stitch each lineage session's chain onto its parent's
// leaf (copies, never stored rows) and run the shared walk, so a fork sees
// ancestors in chain order while sibling sessions stay out of the map.
export function buildBranchSessionContext(sql: EntriesSql, sid: string, leaf: number, readSessionEntries: BranchEntryReader, project?: ProjectContextSource | null): SessionContext {
  const lineage = sessionLineage(sql, sid);
  const perSession: EntryRow[][] = lineage.map((sessionId) => readSessionEntries(sessionId));
  const leafOf = (index: number): number => {
    const row = readSingleRow(sql, "SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", lineage[index]);
    if (row !== null && typeof row.leaf === "number" && Number.isInteger(row.leaf) && row.leaf > 0) return row.leaf;
    let max = 0;
    for (const e of perSession[index]) if (e.cursor > max) max = e.cursor;
    return max;
  };
  const byCursor = new Map<number, EntryRow>();
  for (const entries of perSession) {
    for (const e of entries) {
      if (!byCursor.has(e.cursor)) byCursor.set(e.cursor, { ...e });
    }
  }
  const leaves = lineage.map((_, index) => leafOf(index));
  for (let i = lineage.length - 1; i > 0; i--) {
    const target = leaves[i - 1];
    if (target <= 0) continue;
    let start: EntryRow | null = null;
    for (const e of perSession[i]) {
      const anchor = byCursor.get(e.cursor);
      if (anchor === undefined) continue;
      if (typeof anchor.parent === "number" && anchor.parent > 0 && byCursor.has(anchor.parent)) continue;
      if (start === null || anchor.cursor < start.cursor) start = anchor;
    }
    if (start !== null) start.parent = target;
  }
  let startLeaf = leaf;
  if (!Number.isInteger(startLeaf) || startLeaf <= 0) {
    startLeaf = 0;
    for (let i = lineage.length - 1; i >= 0; i--) {
      if (leaves[i] > 0) {
        startLeaf = leaves[i];
        break;
      }
    }
  }
  return buildSessionContext(startLeaf, (cursor) => byCursor.get(cursor) ?? null, project);
}
