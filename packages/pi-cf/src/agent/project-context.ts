import type { ContextMessage } from "./context.ts";
import type { FileStoreLike } from "../runtime/env.ts";
import type { EntriesSql } from "../store/entries.ts";
import { readSingleRow } from "../store/sql-util.ts";

// Fixed project files per session root (AGENTS.md / CLAUDE.md convention);
// fixed basenames mean a hostile root can never address outside itself except
// via dot segments, which the root guard below refuses (C1 escape rule).
export const PROJECT_CONTEXT_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

export interface ProjectContextSource {
  sql: EntriesSql;
  files: Pick<FileStoreLike, "get">;
  ws: string;
  sid: string;
}

function readUtf8(files: Pick<FileStoreLike, "get">, ws: string, path: string): string | null {
  let raw: ArrayBuffer | Uint8Array | undefined;
  try {
    raw = files.get(ws, path);
  } catch {
    return null;
  }
  if (raw === undefined) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    return null;
  }
}

// One leading user section combining the root's project files, or null when
// the session binds no root or the root holds none. The root comes only from
// SELECT cwd FROM sessions; an absent cwd column throws BLOCKED naming cwd
// instead of falling back to a fixed workspace root.
export function loadProjectContextMessage(source: ProjectContextSource): ContextMessage | null {
  let cwd: unknown;
  try {
    const row = readSingleRow(source.sql, "SELECT cwd FROM sessions WHERE sid = ? LIMIT 1", source.sid);
    cwd = row === null ? null : row.cwd;
  } catch (e) {
    if (e instanceof Error && /no such column:?\s*cwd/i.test(e.message)) {
      throw new Error("project context BLOCKED: sessions.cwd column absent; refusing silent workspace-root fallback");
    }
    throw e;
  }
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const root = cwd.replace(/^\/+|\/+$/g, "");
  if (root.split("/").some((part) => part === "..")) return null;
  const sections: string[] = [];
  for (const name of PROJECT_CONTEXT_FILES) {
    const body = readUtf8(source.files, source.ws, root.length > 0 ? `${root}/${name}` : name);
    if (body !== null) sections.push(`Project context (${name}):\n${body}`);
  }
  if (sections.length === 0) return null;
  return { role: "user", text: sections.join("\n\n"), cursor: 0 };
}
