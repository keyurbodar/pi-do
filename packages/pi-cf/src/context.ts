import type { EntryRow } from "./entries.ts";

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

function parseBodyObject(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

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
      const obj = parseBodyObject(entry.body);
      const level = obj === null ? null : stringField(obj, "level");
      if (level === null) {
        context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
      } else {
        context.thinking = level;
      }
    } else if (entry.type === "model_change") {
      const obj = parseBodyObject(entry.body);
      let provider: string | null = null;
      let id: string | null = null;
      if (obj !== null) {
        const to = obj["to"];
        if (to !== null && typeof to === "object" && !Array.isArray(to)) {
          const record = to as Record<string, unknown>;
          provider = stringField(record, "provider");
          id = stringField(record, "id");
        }
      }
      if (provider === null || id === null) {
        context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
      } else {
        context.model = { provider, id };
      }
    }
  }
  for (let i = windowStart; i < chain.length; i++) {
    const entry = chain[i];
    switch (entry.type) {
      case "thinking_level_change":
      case "model_change": {
        break;
      }
      case "prompt": {
        const obj = parseBodyObject(entry.body);
        const prompt = obj === null ? null : stringField(obj, "prompt");
        if (prompt === null) {
          context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
        } else {
          context.messages.push({ role: "user", text: prompt, cursor: entry.cursor });
        }
        break;
      }
      case "result": {
        const obj = parseBodyObject(entry.body);
        const result = obj === null ? null : stringField(obj, "result");
        if (result === null) {
          context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
        } else {
          context.messages.push({ role: "assistant", text: result, cursor: entry.cursor });
        }
        break;
      }
      case "toolCall": {
        const obj = parseBodyObject(entry.body);
        const tool = obj === null ? null : stringField(obj, "tool");
        if (tool === null) {
          context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
        } else {
          const args = obj === null ? undefined : obj["args"];
          const text = args !== null && typeof args === "object" ? `${tool} ${JSON.stringify(args)}` : tool;
          context.messages.push({ role: "toolCall", text, cursor: entry.cursor });
        }
        break;
      }
      case "toolResult": {
        const obj = parseBodyObject(entry.body);
        const output = obj === null ? null : stringField(obj, "output");
        if (output === null) {
          context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
        } else {
          context.messages.push({ role: "toolResult", text: output, cursor: entry.cursor });
        }
        break;
      }
      case "compaction": {
        const obj = parseBodyObject(entry.body);
        const summary = obj === null ? null : stringField(obj, "summary");
        if (summary === null) {
          context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
        } else {
          context.messages.push({ role: "compactionSummary", text: summary, cursor: entry.cursor });
        }
        break;
      }
      case "steer": {
        const obj = parseBodyObject(entry.body);
        const text = obj === null ? null : stringField(obj, "text");
        if (text === null) {
          context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unreadable-body" });
        } else {
          context.messages.push({ role: "user", text, cursor: entry.cursor });
        }
        break;
      }
      default: {
        context.skipped.push({ cursor: entry.cursor, type: entry.type, reason: "unprojected" });
        break;
      }
    }
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
