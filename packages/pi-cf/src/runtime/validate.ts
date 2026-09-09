import type { ComputerExecutionEnv } from "./env.ts";

export const CAPS = {
  readLines: 2000,
  readBytes: 50 * 1024,
  listDefault: 500,
  listHard: 10000,
  findDefault: 100,
  findHard: 1000,
  grepDefault: 100,
  grepHard: 1000,
  grepLine: 500,
  diagDefault: 200,
  testChars: 32768,
} as const;

export const ERR: Record<string, { error: string; hint: string }> = {
  missingPath: { error: "missing path", hint: 'retry with a workspace-relative path like "notes/hi.txt"' },
  nulPath: { error: "bad path", hint: "paths cannot contain NUL; retry with a plain relative path" },
  slashPath: { error: "bad path", hint: "use posix separators (/), never backslashes" },
  escapePath: { error: "path escapes workspace", hint: "retry with a path inside the workspace (no leading ..)" },
  badLimit: { error: "bad {what}", hint: "retry with {what} as a positive integer" },
  badOffset: { error: "bad offset", hint: "offset is a 1-indexed line number; retry with offset >= 1" },
  badTextOffset: { error: "bad offset", hint: "retry with offset as a UTF-16 code-unit index from 0 to {size} for {file}" },
  offsetBeyond: { error: "offset {start} is beyond end of file", hint: "the file has {total} lines; retry with offset <= {total}" },
  badContent: { error: "bad content", hint: "retry with content as a string" },
  badEdits: { error: "bad edits", hint: "edits must be an array of {oldText, newText}" },
  badEditAt: { error: "bad edits[{i}]", hint: "retry with edits[{i}] as {oldText, newText}" },
  badEditOld: { error: "bad edits[{i}].oldText", hint: "retry with edits[{i}].oldText as a string" },
  badEditNew: { error: "bad edits[{i}].newText", hint: "retry with edits[{i}].newText as a string" },
  badOldText: { error: "bad oldText", hint: "retry with oldText as a string" },
  badNewText: { error: "bad newText", hint: "retry with newText as a string" },
  missingEdits: { error: "missing edits", hint: "retry with edits as a non-empty array of {oldText, newText}" },
  editFailed: { error: "{message}", hint: "keep oldText small but unique; merge overlapping edits into one" },
  entriesLarge: { error: "maxEntries too large", hint: "retry with maxEntries <= {max}" },
  limitLarge: { error: "limit too large", hint: "retry with limit <= {max}" },
  removeRoot: { error: "bad path", hint: "refusing to remove the workspace root; retry with a file or directory path" },
  noSuchFile: { error: "no such file: {path}", hint: "check the path with list first, then retry" },
  isDirectory: { error: "{path} is a directory", hint: "retry with recursive true to delete the whole tree, or remove files one by one" },
  missingFindPattern: { error: "missing pattern", hint: 'retry with a glob like "*.ts" or a substring like "session"' },
  missingGrepPattern: { error: "missing pattern", hint: 'retry with a regex like "TODO|FIXME" or a literal string' },
  badPattern: { error: "bad pattern", hint: "retry with a valid regex, or pass literal true for plain text" },
  badScanPath: { error: "bad path", hint: "diagnostics scans .ts and .tsx files; retry with one or a directory" },
  missingTsPath: { error: "missing path", hint: "retry with a workspace-relative .ts or .tsx path for {tool}" },
  badTsKind: { error: "bad path", hint: "{tool} reads .ts and .tsx files; retry with one" },
  unreadableFile: { error: "unreadable file: {file}", hint: "the file is not UTF-8 text; retry with a text file" },
  diagDown: { error: "diagnostics unavailable", hint: "the TypeScript compiler failed to load; retry the request" },
  badArgs: { error: "bad args", hint: "pass exactly one of file or command, not both and not neither" },
  badName: { error: "bad {what}", hint: "retry with {what} as a plain name, no shell characters" },
  badAction: { error: "bad action", hint: "retry with action as one of install, add, or run" },
  noPackageJson: { error: "no package.json", hint: "seed a package.json at the workspace root first, then retry" },
  badPackageJson: { error: "bad package.json", hint: "fix the JSON at the workspace root, then retry" },
  missingPackage: { error: "missing package", hint: "retry add with package as a plain package name" },
  missingScript: { error: "missing script", hint: "retry run with script naming a package.json script" },
  unknownScript: { error: "unknown script: {script}", hint: "retry with one of: {scripts}" },
  upstream: { error: "{message}", hint: "retry the request with corrected input" },
};

export function failKey(key: string, vars?: Record<string, string | number>): never {
  const entry = ERR[key] ?? { error: key, hint: "retry the request with corrected input" };
  const sub = (template: string): string =>
    template.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) => {
      const value = vars?.[name];
      return value === undefined ? m : String(value);
    });
  throw { error: sub(entry.error), hint: sub(entry.hint) };
}

export function fail(error: string, hint: string): never {
  throw { error, hint };
}

export function normalizeWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    failKey("missingPath");
  }
  const raw = input as string;
  if (raw.includes("\0")) failKey("nulPath");
  if (raw.includes("\\")) failKey("slashPath");
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        failKey("escapePath");
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

export function checkedLimit(limit: unknown, what = "limit"): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    failKey("badLimit", { what });
  }
  return limit as number;
}

export function checkedOffset(offset: unknown): number | undefined {
  if (offset === undefined) return undefined;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) {
    failKey("badOffset");
  }
  return offset as number;
}

export function checkedTextOffset(offset: unknown, text: string, file: string): number {
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > text.length) {
    failKey("badTextOffset", { size: text.length, file });
  }
  return offset as number;
}

export function scopeRoot(path: unknown): string {
  if (path === undefined || path === "") return "";
  return normalizeWorkspacePath(path);
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function readTextOrNull(env: Pick<ComputerExecutionEnv, "readFile">, path: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = env.readFile(path);
  } catch {
    return null;
  }
  return decodeUtf8(bytes);
}

export function joinOutput(stdout: string, stderr: string): string {
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

export function capText(text: string, max: number): { text: string; capped: boolean } {
  if (text.length <= max) return { text, capped: false };
  return { text: `${text.slice(0, max)}\n[output capped at ${max} chars]`, capped: true };
}

export function cappedLimit(limit: unknown, def: number, hard: number, what = "limit", key = "limitLarge"): number {
  const value = checkedLimit(limit, what) ?? def;
  if (value > hard) failKey(key, { max: hard });
  return value;
}

export function resolveScope(
  env: ComputerExecutionEnv,
  path: unknown,
): { root: string; prefix: string; files: string[]; isFile: boolean } {
  const root = path === undefined || path === "" ? "" : normalizeWorkspacePath(path);
  if (root === "") return { root, prefix: "", files: env.readdir("").map((e) => e.path), isFile: false };
  let isFile = false;
  try {
    env.readFile(root);
    isFile = true;
  } catch {
    isFile = false;
  }
  if (isFile) return { root, prefix: root, files: [root], isFile: true };
  const prefix = `${root}/`;
  const files = env.readdir(prefix).map((e) => e.path);
  if (files.length === 0) failKey("noSuchFile", { path: root });
  return { root, prefix, files, isFile: false };
}
