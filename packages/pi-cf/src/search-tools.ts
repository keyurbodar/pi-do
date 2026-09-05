import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
  MAX_READ_BYTES,
  MAX_READ_LINES,
  normalizeWorkspacePath,
  type ToolContext,
} from "./tools.ts";

export const FIND_DEFAULT_LIMIT = 100;
export const FIND_HARD_MAX_LIMIT = 1000;
export const GREP_DEFAULT_LIMIT = 100;
export const GREP_HARD_MAX_LIMIT = 1000;
export const GREP_MAX_LINE_LENGTH = 500;

function fail(error: string, hint: string): never {
  throw { error, hint };
}

function checkedLimit(limit: unknown, what: string): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    fail(`bad ${what}`, `retry with ${what} as a positive integer`);
  }
  return limit as number;
}

function searchRoot(path: unknown): string {
  if (path === undefined || path === "") return "";
  return normalizeWorkspacePath(path);
}

function escapeRegExpChar(c: string): string {
  return c.replace(/[.+^${}()|[\]\\]/, "\\$&");
}

function globToRegExpSrc(glob: string): string {
  let src = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          src += "(.*/)?";
          i += 3;
        } else {
          src += ".*";
          i += 2;
        }
      } else {
        src += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      src += "[^/]";
      i += 1;
    } else {
      src += escapeRegExpChar(c);
      i += 1;
    }
  }
  return src;
}

function hasGlobChars(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function scoreFindMatch(path: string, pattern: string, glob: RegExp | null): number {
  const base = basenameOf(path);
  if (path === pattern || base === pattern) return 0;
  if (base.startsWith(pattern)) return 1;
  if (base.includes(pattern)) return 2;
  if (path.includes(pattern)) return 3;
  if (glob !== null) return 4;
  return 5;
}

function matchFindPath(
  path: string,
  pattern: string,
  glob: RegExp | null,
): { matched: boolean; score: number } {
  if (glob !== null) {
    if (glob.test(path) || glob.test(basenameOf(path))) {
      return { matched: true, score: scoreFindMatch(path, pattern, glob) };
    }
    if (!hasGlobChars(pattern) && path.includes(pattern)) {
      return { matched: true, score: scoreFindMatch(path, pattern, null) };
    }
    return { matched: false, score: 5 };
  }
  if (path.includes(pattern)) {
    return { matched: true, score: scoreFindMatch(path, pattern, null) };
  }
  return { matched: false, score: 5 };
}

export const findTool: AgentHarnessTool<ToolContext, any, { count: number; total: number }> = {
  name: "find",
  label: "Find",
  description:
    "Find workspace files by glob pattern (for example *.ts or **/*.json) or by substring. Paths are workspace-relative posix; path pins the search root (default the workspace root), limit caps the ranked results (default 100). Results rank by match quality then path. Read-only.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "number" },
    },
    required: ["pattern"],
  },
  async execute(
    id,
    params: { pattern: string; path?: string; limit?: number },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ count: number; total: number }>> {
    if (typeof params.pattern !== "string" || params.pattern.length === 0) {
      fail("missing pattern", 'retry with a glob like "*.ts" or a substring like "session"');
    }
    const root = searchRoot(params.path);
    const limit = checkedLimit(params.limit, "limit") ?? FIND_DEFAULT_LIMIT;
    if (limit > FIND_HARD_MAX_LIMIT) {
      fail("limit too large", `retry with limit <= ${FIND_HARD_MAX_LIMIT}`);
    }
    const prefix = root === "" ? "" : `${root}/`;
    const glob = hasGlobChars(params.pattern)
      ? new RegExp(`^(?:.*/)?${globToRegExpSrc(params.pattern)}$`)
      : null;
    const scored: Array<{ path: string; score: number }> = [];
    for (const entry of context.env.readdir(prefix)) {
      const hit = matchFindPath(entry.path, params.pattern, glob);
      if (hit.matched) scored.push({ path: entry.path, score: hit.score });
    }
    scored.sort((a, b) => (a.score === b.score ? (a.path < b.path ? -1 : 1) : a.score - b.score));
    const total = scored.length;
    if (total === 0) {
      return { content: [{ type: "text", text: "(no matches)" }], details: { count: 0, total: 0 } };
    }
    const shown = scored.slice(0, limit).map((e) => e.path);
    let text = shown.join("\n");
    if (total > limit) {
      text += `\n\n[${limit} results shown of ${total}. Use limit=${Math.min(limit * 2, FIND_HARD_MAX_LIMIT)} for more]`;
    }
    return { content: [{ type: "text", text }], details: { count: shown.length, total } };
  },
};

function literalRegExpSrc(pattern: string): string {
  let src = "";
  for (const c of pattern) src += escapeRegExpChar(c);
  return src;
}

function truncateMatchLine(line: string): { text: string; capped: boolean } {
  if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, capped: false };
  return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}[truncated]`, capped: true };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const grepTool: AgentHarnessTool<
  ToolContext,
  any,
  { matches: number; filesSearched: number; filesSkipped: string[] }
> = {
  name: "grep",
  label: "Grep",
  description:
    "Search workspace file contents for a regex (or a literal string with literal true). Paths are workspace-relative posix; path pins a file or directory root (default the workspace root), glob filters file names, limit caps the matches (default 100). Output is file:line: match text. Files cap at 2000 lines or 50KB, match lines cap at 500 chars, non-UTF8 files are skipped with a note. Read-only.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      limit: { type: "number" },
      literal: { type: "boolean" },
      ignoreCase: { type: "boolean" },
    },
    required: ["pattern"],
  },
  async execute(
    id,
    params: {
      pattern: string;
      path?: string;
      glob?: string;
      limit?: number;
      literal?: boolean;
      ignoreCase?: boolean;
    },
    _signal,
    _onUpdate,
    context,
  ): Promise<
    AgentToolResult<{ matches: number; filesSearched: number; filesSkipped: string[] }>
  > {
    if (typeof params.pattern !== "string" || params.pattern.length === 0) {
      fail("missing pattern", "retry with a regex like \"TODO|FIXME\" or a literal string");
    }
    const root = searchRoot(params.path);
    const limit = checkedLimit(params.limit, "limit") ?? GREP_DEFAULT_LIMIT;
    if (limit > GREP_HARD_MAX_LIMIT) {
      fail("limit too large", `retry with limit <= ${GREP_HARD_MAX_LIMIT}`);
    }
    const flags = params.ignoreCase === true ? "i" : "";
    let expr: RegExp;
    try {
      expr = new RegExp(
        params.literal === true ? literalRegExpSrc(params.pattern) : params.pattern,
        flags,
      );
    } catch {
      fail("bad pattern", "retry with a valid regex, or pass literal true for plain text");
    }
    const nameFilter =
      params.glob === undefined || params.glob === ""
        ? null
        : new RegExp(`^(?:.*/)?${globToRegExpSrc(params.glob as string)}$`);
    let candidates: string[];
    if (root === "") {
      candidates = context.env.readdir("").map((e) => e.path);
    } else {
      try {
        context.env.readFile(root);
        candidates = [root];
      } catch {
        const prefix = `${root}/`;
        const under = context.env.readdir(prefix).map((e) => e.path);
        if (under.length === 0) {
          fail(`no such file: ${root}`, "check the path with list or find first, then retry");
        }
        candidates = under;
      }
    }
    candidates.sort();
    const lines: string[] = [];
    const skipped: string[] = [];
    let filesSearched = 0;
    let capped = false;
    for (const file of candidates) {
      if (lines.length >= limit) break;
      if (nameFilter !== null && !nameFilter.test(file) && !nameFilter.test(basenameOf(file))) {
        continue;
      }
      const bytes = context.env.readFile(file);
      const text = decodeUtf8(bytes);
      if (text === null || text.includes("\0")) {
        skipped.push(file);
        continue;
      }
      filesSearched += 1;
      let kept = 0;
      let used = 0;
      const raw = text.split("\n");
      for (let n = 0; n < raw.length; n += 1) {
        if (kept >= MAX_READ_LINES || used > MAX_READ_BYTES) {
          capped = true;
          break;
        }
        const row = raw[n] as string;
        used += row.length + 1;
        kept += 1;
        if (!expr.test(row)) continue;
        const match = truncateMatchLine(row);
        if (match.capped) capped = true;
        lines.push(`${file}:${n + 1}: ${match.text}`);
        if (lines.length >= limit) break;
      }
    }
    if (lines.length === 0 && skipped.length === 0) {
      return {
        content: [{ type: "text", text: "(no matches)" }],
        details: { matches: 0, filesSearched, filesSkipped: skipped },
      };
    }
    let text = lines.join("\n");
    if (skipped.length > 0) {
      text += `\n\n[skipped non-UTF8: ${skipped.join(", ")}]`;
    }
    if (capped) {
      text += `\n\n[output capped at 2000 lines or 50KB per file, 500 chars per match line]`;
    }
    if (lines.length >= limit) {
      text += `\n\n[${limit} matches shown. Use limit=${Math.min(limit * 2, GREP_HARD_MAX_LIMIT)} for more]`;
    }
    return {
      content: [{ type: "text", text }],
      details: { matches: lines.length, filesSearched, filesSkipped: skipped },
    };
  },
};
