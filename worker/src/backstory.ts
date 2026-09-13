// backstory.ts — persistent-bot persona: stored on the sessions row, read
// per turn into the system prompt seam, observable via meta?systemPrompt=1.
import type { EntriesSql } from "pi-cf/store/entries";

export const BACKSTORY_MAX_CHARS = 8192;

export function readBackstory(sql: EntriesSql, sid: string): string | null {
  for (const row of sql.exec("SELECT backstory FROM sessions WHERE sid = ? LIMIT 1", sid)) {
    if (row !== null && typeof row === "object") {
      const v = (row as Record<string, unknown>).backstory;
      return typeof v === "string" && v.length > 0 ? v : null;
    }
  }
  return null;
}
