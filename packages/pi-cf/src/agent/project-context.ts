import type { ContextMessage } from "./context.ts";
import type { FileStoreLike } from "../runtime/env.ts";
import type { EntriesSql } from "../store/entries.ts";
import { readSingleRow } from "../store/sql-util.ts";

// pi's per-directory precedence (refs/pi resource-loader loadContextFileFromDir):
// first existing candidate wins per directory. Casing variants stay distinct
// because the VFS is flat and case-sensitive. Fixed basenames mean a hostile
// root can never address outside itself except via dot segments, which the
// root guard below refuses (C1 escape rule).
const DIR_CANDIDATES: readonly string[] = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const SYSTEM_FILE = "SYSTEM.md";
const APPEND_SYSTEM_FILE = "APPEND_SYSTEM.md";
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024;

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
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, MAX_FILE_BYTES));
  } catch {
    return null;
  }
}

// Ancestor chain for a flat VFS: implicit prefix dirs, outermost first so the
// cwd-nearest file lands last (pi unshifts while walking cwd -> root).
function ancestorDirs(root: string): string[] {
  const dirs = [""];
  let acc = "";
  for (const part of root.split("/")) {
    acc = acc.length === 0 ? part : `${acc}/${part}`;
    dirs.push(acc);
  }
  return dirs;
}

// One leading user section combining the context files for the session cwd, or
// null when the session binds no cwd or holds none. SYSTEM.md at the cwd
// replaces the composed block; APPEND_SYSTEM.md appends to whatever the block
// is. Missing files are silently skipped (pi behavior); global ~/.pi/agent
// files have no equivalent on Cloudflare (no user home) and are never loaded.
// The cwd comes only from SELECT cwd FROM sessions; an absent cwd column throws
// BLOCKED naming cwd instead of falling back to a fixed workspace root.
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
  // A cwd-less session binds the workspace root (""): the flat VFS has real
  // files there, so root AGENTS.md applies to default sessions too.
  const bound: string = typeof cwd === "string" ? cwd : "";
  const root = bound.replace(/^\/+|\/+$/g, "");
  if (root.split("/").some((part) => part === "..")) return null;

  let total = 0;
  const sections: string[] = [];
  for (const dir of ancestorDirs(root)) {
    for (const name of DIR_CANDIDATES) {
      const path = dir.length === 0 ? name : `${dir}/${name}`;
      const body = readUtf8(source.files, source.ws, path);
      if (body === null) continue;
      sections.push(`Project context (${path}):\n${body}`);
      total += body.length;
      break;
    }
    if (total >= MAX_TOTAL_BYTES) break;
  }

  const system = readUtf8(source.files, source.ws, root.length > 0 ? `${root}/${SYSTEM_FILE}` : SYSTEM_FILE);
  const append = readUtf8(source.files, source.ws, root.length > 0 ? `${root}/${APPEND_SYSTEM_FILE}` : APPEND_SYSTEM_FILE);
  let text: string;
  if (system !== null) {
    text = append === null ? system : `${system}\n\n${append}`;
  } else {
    if (sections.length === 0 && append === null) return null;
    text = sections.join("\n\n");
    if (append !== null) text = text.length === 0 ? append : `${text}\n\n${append}`;
  }
  return { role: "user", text, cursor: 0 };
}
