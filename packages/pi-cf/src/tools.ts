import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { ComputerExecutionEnv } from "./env.ts";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  type Edit,
} from "./edit-diff.ts";

// Schemas follow pi packages/coding-agent src/core/tools (read/write/edit/ls)
// and camelAI workers/main/src/pi-container-tools.ts (MIT, qaml-ai/camelAI)
// PI_READ/WRITE/EDIT/LS_PARAMETERS descriptions plus normalizeTextEditArguments
// validation; every execution shell below is rewritten against
// ComputerExecutionEnv. Diff math is imported from ./edit-diff, never retyped.
// Read/list caps (2000 lines, 50KB, 500 entries) match pi truncate.ts and ls.ts.

export interface ToolContext {
  env: ComputerExecutionEnv;
}

export function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

export const MAX_READ_LINES = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const LIST_DEFAULT_MAX_ENTRIES = 500;
export const LIST_HARD_MAX_ENTRIES = 10000;

function fail(error: string, hint: string): never {
  throw { error, hint };
}

// Posix-only workspace paths. Rejects NUL and backslashes outright; resolves
// . and .. lexically and fails closed when .. escapes the workspace root.
// "" is the workspace root (list only; remove refuses it).
export function normalizeWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    fail("missing path", 'retry with a workspace-relative path like "notes/hi.txt"');
  }
  const raw = input as string;
  if (raw.includes("\0")) fail("bad path", "paths cannot contain NUL; retry with a plain relative path");
  if (raw.includes("\\")) fail("bad path", "use posix separators (/), never backslashes");
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        fail("path escapes workspace", "retry with a path inside the workspace (no leading ..)");
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

// Per-file mutation queue over normalized workspace paths. Overlapping
// write/edit/remove calls on one path serialize; the last writer wins.
// Rewritten for the VFS (exact-path keys) from pi file-mutation-queue.ts.
const fileMutationQueues = new Map<string, Promise<void>>();

export function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileMutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const cur = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => cur);
  fileMutationQueues.set(path, tail);
  return prev.then(fn).finally(() => {
    release();
    if (fileMutationQueues.get(path) === tail) fileMutationQueues.delete(path);
  });
}

function checkedOffset(offset: unknown): number | undefined {
  if (offset === undefined) return undefined;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) {
    fail("bad offset", "offset is a 1-indexed line number; retry with offset >= 1");
  }
  return offset as number;
}

function checkedLimit(limit: unknown, what: string): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    fail(`bad ${what}`, `retry with ${what} as a positive integer`);
  }
  return limit as number;
}

function readLines(
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): { out: string; start: number; end: number; total: number; capped: boolean } {
  const lines = text.split("\n");
  const total = lines.length;
  const start = offset === undefined ? 1 : offset;
  if (start > total) {
    fail(`offset ${start} is beyond end of file`, `the file has ${total} lines; retry with offset <= ${total}`);
  }
  let end = limit === undefined ? total : Math.min(start + limit - 1, total);
  let selected = lines.slice(start - 1, end);
  let capped = false;
  if (selected.length > MAX_READ_LINES) {
    selected = selected.slice(0, MAX_READ_LINES);
    end = start + MAX_READ_LINES - 1;
    capped = true;
  }
  let bytes = 0;
  let cut = selected.length;
  for (let i = 0; i < selected.length; i++) {
    bytes += new TextEncoder().encode(selected[i]).byteLength + (i === 0 ? 0 : 1);
    if (bytes > MAX_READ_BYTES) {
      cut = i;
      capped = true;
      break;
    }
  }
  if (cut < selected.length) {
    selected = selected.slice(0, cut);
    end = start + cut - 1;
  }
  return { out: selected.join("\n"), start, end, total, capped };
}

export const readTool: AgentHarnessTool<ToolContext, any, { bytes: number }> = {
  name: "read",
  label: "Read",
  description:
    "Read a workspace file as UTF-8 text. Paths are workspace-relative. offset is a 1-indexed line offset for large files; limit caps the lines returned. Output is capped at 2000 lines or 50KB, whichever hits first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["path"],
  },
  async execute(
    id,
    params: { path: string; offset?: number; limit?: number },
    _signal,
    _onUpdate,
    context,
  ) {
    const path = normalizeWorkspacePath(params.path);
    const offset = checkedOffset(params.offset);
    const limit = checkedLimit(params.limit, "limit");
    const bytes = context.env.readFile(path);
    const text = new TextDecoder().decode(bytes);
    if (offset === undefined && limit === undefined) {
      return {
        content: [{ type: "text", text }],
        details: { bytes: bytes.byteLength },
      };
    }
    const slice = readLines(text, offset, limit);
    let out = slice.out;
    if (slice.capped || slice.end < slice.total) {
      out += `\n\n[Showing lines ${slice.start}-${slice.end} of ${slice.total}. Use offset=${slice.end + 1} to continue.]`;
    }
    return {
      content: [{ type: "text", text: out }],
      details: { bytes: bytes.byteLength },
    };
  },
};

export const writeTool: AgentHarnessTool<ToolContext, any, { bytes: number }> = {
  name: "write",
  label: "Write",
  description:
    "Write content to a workspace file. Creates the file if it doesn't exist, overwrites if it does. Paths are workspace-relative; parent paths are virtual, no directories to create. Serialized per file: the last writer wins.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(id, params: { path: string; content: string }, _signal, _onUpdate, context) {
    const path = normalizeWorkspacePath(params.path);
    if (typeof params.content !== "string") {
      fail("bad content", "retry with content as a string");
    }
    const stat = await withFileMutationQueue(path, async () =>
      context.env.writeFile(path, params.content),
    );
    return {
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
      details: { bytes: stat.bytes },
    };
  },
};

function normalizeEdits(input: unknown): Edit[] {
  const record = (input ?? {}) as Record<string, unknown>;
  let raw = record["edits"];
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      fail("bad edits", "edits must be an array of {oldText, newText}");
    }
  }
  const edits: Edit[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        fail(`bad edits[${i}]`, `retry with edits[${i}] as {oldText, newText}`);
      }
      const rec = entry as Record<string, unknown>;
      if (typeof rec["oldText"] !== "string") {
        fail(`bad edits[${i}].oldText`, `retry with edits[${i}].oldText as a string`);
      }
      if (typeof rec["newText"] !== "string") {
        fail(`bad edits[${i}].newText`, `retry with edits[${i}].newText as a string`);
      }
      edits.push({ oldText: rec["oldText"] as string, newText: rec["newText"] as string });
    });
  }
  const oldText = record["oldText"];
  const newText = record["newText"];
  if (oldText !== undefined || newText !== undefined) {
    if (typeof oldText !== "string") fail("bad oldText", "retry with oldText as a string");
    if (typeof newText !== "string") fail("bad newText", "retry with newText as a string");
    edits.push({ oldText: oldText as string, newText: newText as string });
  }
  if (edits.length === 0) {
    fail("missing edits", "retry with edits as a non-empty array of {oldText, newText}");
  }
  return edits;
}

export const editTool: AgentHarnessTool<
  ToolContext,
  any,
  { diff: string; patch: string; firstChangedLine?: number }
> = {
  name: "edit",
  label: "Edit",
  description:
    "Edit a workspace file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit. Returns a display diff plus a unified patch. Serialized per file: the last writer wins.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async execute(id, params: unknown, _signal, _onUpdate, context) {
    const record = (params ?? {}) as Record<string, unknown>;
    const path = normalizeWorkspacePath(record["path"]);
    const edits = normalizeEdits(params);
    return withFileMutationQueue(path, async () => {
      const bytes = context.env.readFile(path);
      const raw = new TextDecoder().decode(bytes);
      const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
      const content = bom ? raw.slice(1) : raw;
      const ending = detectLineEnding(content);
      const normalized = normalizeToLF(content);
      let applied: { baseContent: string; newContent: string };
      try {
        applied = applyEditsToNormalizedContent(normalized, edits, path);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e ?? "edit failed");
        fail(message, "keep oldText small but unique; merge overlapping edits into one");
      }
      const base = applied.baseContent;
      const next = applied.newContent;
      context.env.writeFile(path, bom + restoreLineEndings(next, ending));
      const preview = generateDiffString(base, next);
      const patch = generateUnifiedPatch(path, base, next);
      const text =
        `Successfully replaced ${edits.length} block(s) in ${path}.\n${preview.diff}`;
      return {
        content: [{ type: "text", text }],
        details: { diff: preview.diff, patch, firstChangedLine: preview.firstChangedLine },
      };
    });
  },
};

export const listTool: AgentHarnessTool<ToolContext, any, { count: number }> = {
  name: "list",
  label: "List",
  description:
    "List workspace files under a directory prefix, sorted alphabetically. Directories carry a / suffix. recursive lists the whole subtree; maxEntries caps the entries returned (default 500). Paths are workspace-relative posix.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" },
      maxEntries: { type: "number" },
    },
    required: [],
  },
  async execute(
    id,
    params: { path?: string; recursive?: boolean; maxEntries?: number },
    _signal,
    _onUpdate,
    context,
  ) {
    const dir = params.path === undefined || params.path === "" ? "" : normalizeWorkspacePath(params.path);
    const recursive = params.recursive ?? false;
    const maxEntries = checkedLimit(params.maxEntries, "maxEntries") ?? LIST_DEFAULT_MAX_ENTRIES;
    if (maxEntries > LIST_HARD_MAX_ENTRIES) {
      fail("maxEntries too large", `retry with maxEntries <= ${LIST_HARD_MAX_ENTRIES}`);
    }
    const prefix = dir === "" ? "" : dir.endsWith("/") ? dir : `${dir}/`;
    const all = context.env.readdir(prefix);
    const names: string[] = [];
    const seenDirs = new Set<string>();
    for (const entry of all) {
      const rest = entry.path.slice(prefix.length);
      if (rest.length === 0) continue;
      if (recursive) {
        names.push(entry.path);
        continue;
      }
      const slash = rest.indexOf("/");
      if (slash === -1) {
        names.push(entry.path);
      } else {
        const sub = `${prefix}${rest.slice(0, slash + 1)}`;
        if (!seenDirs.has(sub)) {
          seenDirs.add(sub);
          names.push(sub);
        }
      }
    }
    if (names.length === 0) {
      return { content: [{ type: "text", text: "(empty directory)" }], details: { count: 0 } };
    }
    let out = names.slice(0, maxEntries);
    let text = out.join("\n");
    if (names.length > maxEntries) {
      text += `\n\n[${maxEntries} entries limit reached. Use maxEntries=${maxEntries * 2} for more]`;
    }
    return { content: [{ type: "text", text }], details: { count: out.length } };
  },
};

export const removeTool: AgentHarnessTool<ToolContext, any, { removed: string[] }> = {
  name: "remove",
  label: "Remove",
  description:
    "Delete a workspace file, or a directory tree with recursive true. Paths are workspace-relative posix; .. escape fails closed. Without recursive, a non-empty directory is refused.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" },
    },
    required: ["path"],
  },
  async execute(
    id,
    params: { path: string; recursive?: boolean },
    _signal,
    _onUpdate,
    context,
  ) {
    const path = normalizeWorkspacePath(params.path);
    if (path === "") {
      fail("bad path", "refusing to remove the workspace root; retry with a file or directory path");
    }
    const recursive = params.recursive ?? false;
    const prefix = `${path}/`;
    return withFileMutationQueue(path, async () => {
      let removed: string[] = [];
      try {
        context.env.readFile(path);
        context.env.rm(path);
        removed = [path];
      } catch {
        const under = context.env.readdir(prefix).map((e) => e.path);
        if (under.length === 0) {
          fail(`no such file: ${path}`, "check the path with list first, then retry");
        }
        if (!recursive) {
          fail(
            `${path} is a directory`,
            "retry with recursive true to delete the whole tree, or remove files one by one",
          );
        }
        for (const p of under) {
          await withFileMutationQueue(p, async () => context.env.rm(p));
        }
        removed = under;
      }
      const text =
        removed.length === 1
          ? `Removed ${removed[0]}`
          : `Removed ${removed.length} files under ${prefix}\n${removed.join("\n")}`;
      return { content: [{ type: "text", text }], details: { removed } };
    });
  },
};

export const bashTool: AgentHarnessTool<ToolContext, any, { exit: number }> = {
  name: "bash",
  label: "Bash",
  description: "Run a shell command via just-bash in an isolate (no node/python). Each call gets a fresh FS, cwd pinned per call. Output capped at 1 MiB, 10s timeout. Output is captured text.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  async execute(id, params: { command: string }, _signal, _onUpdate, context) {
    const out = await context.env.exec(params.command);
    const text = out.stderr ? `${out.stdout}\n${out.stderr}` : out.stdout;
    return {
      content: [{ type: "text", text }],
      details: { exit: out.exit },
    };
  },
};
