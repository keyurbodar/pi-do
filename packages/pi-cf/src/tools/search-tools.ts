import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateLine } from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";
import {
  spillCapped,
  type ToolContext,
} from "./tools.ts";
import { CAPS, cappedLimit, checkedLimit, decodeUtf8, failKey, resolveScope } from "../runtime/validate.ts";

export const GREP_DEFAULT_LIMIT = CAPS.grepDefault;
export const GREP_HARD_MAX_LIMIT = CAPS.grepHard;
export const FIND_DEFAULT_LIMIT = CAPS.findDefault;
export const FIND_HARD_MAX_LIMIT = CAPS.findHard;
export const GREP_MAX_LINE_LENGTH = CAPS.grepLine;
export const GREP_MAX_CONTEXT = CAPS.grepContextMax;

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
    "Find workspace files by glob pattern (for example *.ts or **/*.json) or by substring. Paths are workspace-relative posix; path pins the search root (default the workspace root), limit caps the ranked results (default 1000). Results rank by match quality then path. Read-only.",
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
    "Search workspace file contents for a regex (or a literal string with literal true). Paths are workspace-relative posix; path pins a file or directory root (default the workspace root), glob filters file names, limit caps the matches (default 100), context adds 0-5 lines around each match (default 0). node_modules, .git and tmp are skipped. Output is file:line: match text with context lines marked by -; match lines cap at 500 chars, files cap at 1MiB per file, non-UTF8 files are skipped with a note. Read-only.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      limit: { type: "number" },
      literal: { type: "boolean" },
      ignoreCase: { type: "boolean" },
      context: { type: "number" },
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
      context?: number;
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
    const contextLines =
      params.context === undefined
        ? 0
        : (checkedLimit(params.context, "context") ?? 0);
    if (contextLines > GREP_MAX_CONTEXT) failKey("contextLarge", { max: GREP_MAX_CONTEXT });
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
    const fullLines: string[] = [];
    const skipped: string[] = [];
    let filesSearched = 0;
    let truncatedLines = false;
    let matchCount = 0;
    for (const file of candidates) {
      if (matchCount >= limit) break;
      if (nameFilter !== null && !globMatch(file, nameFilter)) {
        continue;
      }
      const bytes = context.env.readFile(file);
      const readBytes = bytes.byteLength > CAPS.grepFileBytes ? bytes.slice(0, CAPS.grepFileBytes) : bytes;
      const full = decodeUtf8(readBytes);
      if (full === null || full.includes("\0")) {
        skipped.push(file);
        continue;
      }
      filesSearched += 1;
      const raw = full.split("\n");
      for (let n = 0; n < raw.length; n += 1) {
        const row = raw[n] as string;
        if (!expr.test(row)) continue;
        matchCount += 1;
        const start = contextLines > 0 ? Math.max(0, n - contextLines) : n;
        const end = contextLines > 0 ? Math.min(raw.length - 1, n + contextLines) : n;
        for (let i = start; i <= end; i += 1) {
          const rawLine = (raw[i] ?? "").replace(/\r/g, "");
          const match = truncateLine(rawLine, GREP_MAX_LINE_LENGTH);
          if (match.wasTruncated) truncatedLines = true;
          const separator = i === n ? ":" : "-";
          lines.push(`${file}${separator}${i + 1}${separator} ${match.text}`);
          fullLines.push(`${file}${separator}${i + 1}${separator} ${rawLine}`);
        }
        if (matchCount >= limit) break;
      }
    }
    if (matchCount === 0 && skipped.length === 0) {
      return {
        content: [{ type: "text", text: "(no matches)" }],
        details: { matches: 0, filesSearched, filesSkipped: skipped },
      };
    }
    let text = lines.join("\n");
    const fullText = fullLines.join("\n");
    if (skipped.length > 0) {
      text += `\n\n[skipped non-UTF8: ${skipped.join(", ")}]`;
      fullLines.length = 0;
    }
    if (truncatedLines || matchCount >= limit) {
      const note = truncatedLines ? `[long lines truncated at ${GREP_MAX_LINE_LENGTH} chars]` : `[${limit} matches shown. Use limit=${Math.min(limit * 2, GREP_HARD_MAX_LIMIT)} for more]`;
      if (fullLines.length > 0) text += `\n\n${spillCapped(context, "grep", fullText, note)}`;
      else text += `\n\n${note}`;
    }
    return {
      content: [{ type: "text", text }],
      details: { matches: matchCount, filesSearched, filesSkipped: skipped },
    };
  },
};
