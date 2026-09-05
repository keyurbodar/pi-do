import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
  normalizeWorkspacePath,
  type ToolContext,
} from "./tools.ts";

export const TEST_MAX_OUTPUT_CHARS = 32768;

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

function capOutput(text: string): { text: string; capped: boolean } {
  if (text.length <= TEST_MAX_OUTPUT_CHARS) return { text, capped: false };
  return { text: `${text.slice(0, TEST_MAX_OUTPUT_CHARS)}\n[output capped at ${TEST_MAX_OUTPUT_CHARS} chars]`, capped: true };
}

interface StructureIssue {
  line: number;
  message: string;
}

interface Bracket {
  ch: string;
  line: number;
  template: boolean;
}

function scanTypeScript(text: string): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const match: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const brackets: Bracket[] = [];
  const modes: string[] = ["code"];
  let line = 1;
  let lineComment = false;
  let blockComment = false;
  let blockLine = 0;
  let stringLine = 0;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = i + 1 < text.length ? (text[i + 1] as string) : "";
    if (c === "\n") {
      const top = modes[modes.length - 1] as string;
      if ((top === "'" || top === '"') && !lineComment && !blockComment) {
        issues.push({ line: stringLine, message: `unterminated string opened at line ${stringLine}` });
        modes.pop();
      }
      line += 1;
      lineComment = false;
      i += 1;
      continue;
    }
    if (lineComment) {
      i += 1;
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    const top = modes[modes.length - 1] as string;
    if (top === "'" || top === '"') {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === top) modes.pop();
      i += 1;
      continue;
    }
    if (top === "`") {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "`") modes.pop();
      else if (c === "$" && next === "{") {
        brackets.push({ ch: "{", line, template: true });
        modes.push("code");
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      blockComment = true;
      blockLine = line;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      modes.push(c);
      stringLine = line;
      i += 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      brackets.push({ ch: c, line, template: false });
      i += 1;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const open = brackets.pop();
      if (open === undefined) {
        issues.push({ line, message: `unexpected "${c}" with nothing open` });
      } else if (match[c] !== open.ch) {
        issues.push({ line, message: `mismatched "${open.ch}" opened at line ${open.line}, closed with "${c}"` });
      } else if (open.template) {
        modes.pop();
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  const top = modes[modes.length - 1] as string;
  if (top === "'" || top === '"') {
    issues.push({ line: stringLine, message: `unterminated string opened at line ${stringLine}` });
  } else if (top === "`") {
    issues.push({ line: stringLine, message: `unterminated template opened at line ${stringLine}` });
  }
  if (blockComment) {
    issues.push({ line: blockLine, message: `unterminated block comment opened at line ${blockLine}` });
  }
  for (let b = brackets.length - 1; b >= 0; b -= 1) {
    const open = brackets[b] as Bracket;
    issues.push({ line: open.line, message: `unclosed "${open.ch}" opened at line ${open.line}` });
  }
  issues.sort((a, b) => a.line - b.line);
  return issues;
}

function isTypeScriptFile(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

export const diagnosticsTool: AgentHarnessTool<
  ToolContext,
  any,
  { files: number; errors: number }
> = {
  name: "diagnostics",
  label: "Diagnostics",
  description:
    "Check TypeScript files for structural breakage: unbalanced brackets, unexpected closers, unterminated strings, templates, and block comments, reported as file:line issues. Paths are workspace-relative posix; path takes one .ts file or a directory root (default the workspace root), only .ts and .tsx files are scanned. This is a structural scan, not a typecheck: the isolate shell cannot run tsc, so semantic types are out of reach. Run it after edits to catch a broken file next turn. Read-only.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
    },
    required: [],
  },
  async execute(
    id,
    params: { path?: string; limit?: number },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ files: number; errors: number }>> {
    const root = searchRoot(params.path);
    const limit = checkedLimit(params.limit, "limit") ?? 200;
    let candidates: string[];
    if (root === "") {
      candidates = context.env.readdir("").map((e) => e.path);
    } else {
      try {
        context.env.readFile(root);
        if (!isTypeScriptFile(root)) {
          fail("bad path", "diagnostics scans .ts and .tsx files; retry with one or a directory");
        }
        candidates = [root];
      } catch (e) {
        if (e !== null && typeof e === "object" && "error" in e && e.error === "bad path") throw e;
        const prefix = `${root}/`;
        const under = context.env.readdir(prefix).map((e) => e.path);
        if (under.length === 0) {
          fail(`no such file: ${root}`, "check the path with list or find first, then retry");
        }
        candidates = under;
      }
    }
    const files = candidates.filter(isTypeScriptFile).sort();
    const rows: string[] = [];
    for (const file of files) {
      const bytes = context.env.readFile(file);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        rows.push(`${file}: skipped (non-UTF8)`);
        continue;
      }
      for (const issue of scanTypeScript(text)) {
        rows.push(`${file}:${issue.line}: ${issue.message}`);
        if (rows.length >= limit) break;
      }
      if (rows.length >= limit) break;
    }
    const errors = rows.filter((r) => !r.includes("skipped (non-UTF8)")).length;
    if (rows.length === 0) {
      const noun = files.length === 1 ? "file" : "files";
      return {
        content: [{ type: "text", text: `(no issues in ${files.length} ${noun})` }],
        details: { files: files.length, errors: 0 },
      };
    }
    return {
      content: [{ type: "text", text: rows.join("\n") }],
      details: { files: files.length, errors },
    };
  },
};

export const testTool: AgentHarnessTool<ToolContext, any, { passed: boolean; exit: number }> = {
  name: "test",
  label: "Test",
  description:
    "Run one test file or one shell command through the shell seam and report structured pass or fail with captured output. Pass exactly one of file (a workspace-relative test script, executed by content) or command. Exit 0 is pass, anything else is fail. The isolate shell runs builtins plus sh with no node or npm, so test files must be shell-runnable. Read-only apart from whatever the command itself does.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string" },
      command: { type: "string" },
    },
    required: [],
  },
  async execute(
    id,
    params: { file?: string; command?: string },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ passed: boolean; exit: number }>> {
    const hasFile = params.file !== undefined && params.file !== "";
    const hasCommand = typeof params.command === "string" && params.command.length > 0;
    if (hasFile === hasCommand) {
      fail("bad args", "pass exactly one of file or command, not both and not neither");
    }
    let label: string;
    let script: string;
    if (hasFile) {
      const path = normalizeWorkspacePath(params.file);
      label = path;
      script = new TextDecoder().decode(context.env.readFile(path));
    } else {
      label = (params.command as string).slice(0, 120);
      script = params.command as string;
    }
    const out = await context.env.exec(script);
    const combined = out.stderr ? `${out.stdout}\n${out.stderr}` : out.stdout;
    const capped = capOutput(combined);
    const passed = out.exit === 0;
    const head = passed ? `PASS ${label}` : `FAIL ${label} (exit ${out.exit})`;
    return {
      content: [{ type: "text", text: capped.text ? `${head}\n${capped.text}` : head }],
      details: { passed, exit: out.exit },
    };
  },
};
function shellSafe(value: string, what: string): string {
  if (value.length === 0 || /[\n;|&`$()<>"'\\]/.test(value)) {
    fail(`bad ${what}`, `retry with ${what} as a plain name, no shell characters`);
  }
  return value;
}

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

export const pmTool: AgentHarnessTool<
  ToolContext,
  any,
  { action: string; exit: number; lockfile: string | null }
> = {
  name: "pm",
  label: "PM",
  description:
    "Run the project package manager through the shell seam: install dependencies, add one package, or run one package.json script. Actions: install, add (needs package), run (needs script). Reads package.json from the workspace root first and fails closed when it is missing; install uses npm ci when package-lock.json is present. Names the lockfile found, if any. Returns the structured exit plus captured output. Read-only apart from whatever the manager itself does.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string" },
      package: { type: "string" },
      script: { type: "string" },
    },
    required: ["action"],
  },
  async execute(
    id,
    params: { action: string; package?: string; script?: string },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ action: string; exit: number; lockfile: string | null }>> {
    if (params.action !== "install" && params.action !== "add" && params.action !== "run") {
      fail("bad action", "retry with action as one of install, add, or run");
    }
    let raw: string;
    try {
      raw = new TextDecoder().decode(context.env.readFile("package.json"));
    } catch {
      fail("no package.json", "seed a package.json at the workspace root first, then retry");
    }
    let scripts: string[] = [];
    try {
      const manifest = JSON.parse(raw) as { scripts?: Record<string, string> };
      scripts = Object.keys(manifest.scripts ?? {});
    } catch {
      fail("bad package.json", "fix the JSON at the workspace root, then retry");
    }
    let lockfile: string | null = null;
    for (const name of LOCKFILES) {
      try {
        context.env.readFile(name);
        lockfile = name;
        break;
      } catch {
        continue;
      }
    }
    let command: string;
    if (params.action === "install") {
      command = lockfile === "package-lock.json" ? "npm ci" : "npm install";
    } else if (params.action === "add") {
      if (typeof params.package !== "string" || params.package.length === 0) {
        fail("missing package", "retry add with package as a plain package name");
      }
      command = `npm install ${shellSafe(params.package as string, "package")}`;
    } else {
      if (typeof params.script !== "string" || params.script.length === 0) {
        fail("missing script", "retry run with script naming a package.json script");
      }
      const script = shellSafe(params.script as string, "script");
      if (!scripts.includes(script)) {
        fail(`unknown script: ${script}`, `retry with one of: ${scripts.join(", ") || "(no scripts)"}`);
      }
      command = `npm run ${script}`;
    }
    const out = await context.env.exec(command);
    const combined = out.stderr ? `${out.stdout}\n${out.stderr}` : out.stdout;
    const capped = capOutput(combined);
    const head = `${params.action} (exit ${out.exit}, lockfile: ${lockfile ?? "none"})`;
    return {
      content: [{ type: "text", text: capped.text ? `${head}\n${capped.text}` : head }],
      details: { action: params.action, exit: out.exit, lockfile },
    };
  },
};
