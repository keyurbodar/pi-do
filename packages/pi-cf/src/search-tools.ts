import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { truncateHead, truncateLine } from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";
import {
  type ToolContext,
} from "./tools.ts";
import { CAPS, cappedLimit, decodeUtf8, failKey, resolveScope } from "./validate.ts";

export const FIND_DEFAULT_LIMIT = CAPS.findDefault;
export const FIND_HARD_MAX_LIMIT = CAPS.findHard;
export const GREP_DEFAULT_LIMIT = CAPS.grepDefault;
export const GREP_HARD_MAX_LIMIT = CAPS.grepHard;
export const GREP_MAX_LINE_LENGTH = CAPS.grepLine;

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function globMatch(path: string, pattern: string): boolean {
  return (
    minimatch(path, pattern, { dot: true }) ||
    minimatch(path, `**/${pattern}`, { dot: true }) ||
    minimatch(basenameOf(path), pattern, { dot: true })
  );
}

function scoreFindMatch(path: string, pattern: string, isGlob: boolean): number {
  const base = basenameOf(path);
  if (path === pattern || base === pattern) return 0;
  if (base.startsWith(pattern)) return 1;
  if (base.includes(pattern)) return 2;
  if (path.includes(pattern)) return 3;
  if (isGlob) return 4;
  return 5;
}

function matchFindPath(
  path: string,
  pattern: string,
  isGlob: boolean,
): { matched: boolean; score: number } {
  if (isGlob) {
    if (globMatch(path, pattern)) {
      return { matched: true, score: scoreFindMatch(path, pattern, isGlob) };
    }
    return { matched: false, score: 5 };
  }
  if (path.includes(pattern)) {
    return { matched: true, score: scoreFindMatch(path, pattern, isGlob) };
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
    void id;
    if (typeof params.pattern !== "string" || params.pattern.length === 0) {
      failKey("missingFindPattern");
    }
    const { files } = resolveScope(context.env, params.path);
    const limit = cappedLimit(params.limit, FIND_DEFAULT_LIMIT, FIND_HARD_MAX_LIMIT);
    const pattern = params.pattern;
    const isGlob = pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
    const scored: Array<{ path: string; score: number }> = [];
    for (const path of files) {
      const hit = matchFindPath(path, pattern, isGlob);
      if (hit.matched) scored.push({ path, score: hit.score });
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
  for (const c of pattern) src += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
  return src;
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
    void id;
    if (typeof params.pattern !== "string" || params.pattern.length === 0) {
      failKey("missingGrepPattern");
    }
    const { files } = resolveScope(context.env, params.path);
    const limit = cappedLimit(params.limit, GREP_DEFAULT_LIMIT, GREP_HARD_MAX_LIMIT);
    const flags = params.ignoreCase === true ? "i" : "";
    let expr: RegExp;
    try {
      expr = new RegExp(
        params.literal === true ? literalRegExpSrc(params.pattern) : params.pattern,
        flags,
      );
    } catch {
      failKey("badPattern");
    }
    const nameFilter = params.glob === undefined || params.glob === "" ? null : (params.glob as string);
    const candidates = [...files].sort();
    const lines: string[] = [];
    const skipped: string[] = [];
    let filesSearched = 0;
    let capped = false;
    for (const file of candidates) {
      if (lines.length >= limit) break;
      if (nameFilter !== null && !globMatch(file, nameFilter)) {
        continue;
      }
      const bytes = context.env.readFile(file);
      const full = decodeUtf8(bytes);
      if (full === null || full.includes("\0")) {
        skipped.push(file);
        continue;
      }
      filesSearched += 1;
      const head = truncateHead(full, { maxLines: CAPS.readLines, maxBytes: CAPS.readBytes });
      if (head.truncated) capped = true;
      const raw = head.content.split("\n");
      for (let n = 0; n < raw.length; n += 1) {
        const row = raw[n] as string;
        if (!expr.test(row)) continue;
        const match = truncateLine(row, GREP_MAX_LINE_LENGTH);
        if (match.wasTruncated) capped = true;
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
