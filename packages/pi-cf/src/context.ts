import type { EntryRow } from "./entries.ts";
import { ENTRY_PROJECTION, parseJsonObject, strField } from "./sql-util.ts";

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
  while (total > budgetTokens) {
    const index = kept.findIndex((message) => message.role !== "compactionSummary");
    if (index === -1) {
      break;
    }
    total -= estimateTokens(kept[index].text);
    kept.splice(index, 1);
    dropped += 1;
  }
  return {
    messages: kept,
    model: ctx.model,
    thinking: ctx.thinking,
    toolNames: ctx.toolNames,
    skipped: ctx.skipped,
    truncated: dropped > 0,
    dropped,
  };
}

export type EntryReader = (cursor: number) => EntryRow | null;

export function buildSessionContext(leaf: number, readEntry: EntryReader): SessionContext {
  const context: SessionContext = { messages: [], model: null, thinking: "off", toolNames: null, skipped: [], truncated: false, dropped: 0 };
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
    const proj = ENTRY_PROJECTION[entry.type];
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

export function buildSessionContextFromEntries(entries: readonly EntryRow[], leaf: number): SessionContext {
  const byCursor = new Map<number, EntryRow>();
  for (const entry of entries) {
    byCursor.set(entry.cursor, entry);
  }
  return buildSessionContext(leaf, (cursor) => byCursor.get(cursor) ?? null);
}
