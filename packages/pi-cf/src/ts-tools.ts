import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { normalizeWorkspacePath, type ToolContext } from "./tools.ts";
import { ComputerExecutionEnv } from "./env.ts";
import { CAPS, cappedLimit, checkedTextOffset, decodeUtf8, failKey, readTextOrNull, resolveScope } from "./validate.ts";
import {
  TS_LIB_FILE_NAMES,
  TS_LIB_TEXTS,
} from "./ts-libs.generated.ts";
import type * as ts from "typescript";

type TypeScript = typeof import("typescript");

interface CachedFile {
  version: number;
  text: string;
}
interface WorkspaceSession {
  service: ts.LanguageService;
  compiler: TypeScript;
  roots: string[];
  files: Map<string, CachedFile>;
}

let compilerPromise: Promise<TypeScript> | undefined;
const sessions = new Map<string, WorkspaceSession>();

function loadCompiler(): Promise<TypeScript> {
  if (!compilerPromise) compilerPromise = import("typescript");
  return compilerPromise;
}

function isTs(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

function readLive(env: ComputerExecutionEnv, name: string): string | undefined {
  const lib = TS_LIB_TEXTS[name];
  if (lib !== undefined) return lib;
  return readTextOrNull(env, name) ?? undefined;
}

function workspaceTsFiles(env: ComputerExecutionEnv): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  for (const entry of env.readdir("")) {
    const path = entry.path;
    if (!isTs(path) || path === "node_modules" || path.startsWith("node_modules/")) continue;
    if (readTextOrNull(env, path) === null) skipped.push(path);
    else files.push(path);
  }
  files.sort();
  skipped.sort();
  return { files, skipped };
}

function scopedTsFiles(env: ComputerExecutionEnv, path: unknown): { files: string[]; scoped: string[]; skipped: string[] } {
  const { files, skipped } = workspaceTsFiles(env);
  const scope = resolveScope(env, path);
  if (scope.root === "") return { files, scoped: files, skipped };
  if (files.includes(scope.root) || skipped.includes(scope.root)) return { files, scoped: [scope.root], skipped };
  if (scope.isFile) {
    failKey("badScanPath");
  }
  const under = [...files, ...skipped].filter((f) => f.startsWith(scope.prefix)).sort();
  if (under.length === 0) {
    failKey("noSuchFile", { path: scope.root });
  }
  return { files, scoped: under, skipped };
}

function childDirs(env: ComputerExecutionEnv, dir: string): string[] {
  const prefix = dir === "" || dir === "." ? "" : `${dir.replace(/\/+$/, "")}/`;
  let entries: { path: string }[];
  try {
    entries = env.readdir(prefix);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const entry of entries) {
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) out.add(rest.slice(0, slash));
  }
  return [...out];
}

function dirExists(env: ComputerExecutionEnv, dir: string): boolean {
  if (dir === "" || dir === "." || dir === "/") return true;
  try {
    return env.readdir(`${dir.replace(/\/+$/, "")}/`).length > 0;
  } catch {
    return false;
  }
}

function serviceFor(env: ComputerExecutionEnv, compiler: TypeScript, roots: string[]): WorkspaceSession {
  const key = env.workspaceId;
  const hit = sessions.get(key);
  if (hit) {
    hit.roots = roots;
    return hit;
  }
  const session: WorkspaceSession = {
    service: undefined as unknown as ts.LanguageService,
    compiler,
    roots,
    files: new Map<string, CachedFile>(),
  };
  const options: ts.CompilerOptions = {
    strict: true,
    target: compiler.ScriptTarget.ES2022,
    module: compiler.ModuleKind.ESNext,
    moduleResolution: compiler.ModuleResolutionKind.Bundler,
    jsx: compiler.JsxEmit.ReactJSX,
    skipLibCheck: true,
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...session.roots, ...TS_LIB_FILE_NAMES],
    getScriptVersion: (name) => {
      const text = readLive(env, name);
      if (text === undefined) {
        const prev = session.files.get(name);
        return prev ? String(prev.version) : "";
      }
      const prev = session.files.get(name);
      if (prev && prev.text === text) return String(prev.version);
      const version = (prev ? prev.version : -1) + 1;
      session.files.set(name, { version, text });
      return String(version);
    },
    getScriptSnapshot: (name) => {
      const text = readLive(env, name) ?? session.files.get(name)?.text;
      return text === undefined ? undefined : compiler.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => TS_LIB_FILE_NAMES[0],
    fileExists: (name) => TS_LIB_TEXTS[name] !== undefined || readLive(env, name) !== undefined,
    readFile: (name) => readLive(env, name),
    directoryExists: (dir) => dirExists(env, dir),
    getDirectories: (dir) => childDirs(env, dir),
    getScriptKind: (name) => (name.endsWith(".tsx") ? compiler.ScriptKind.TSX : compiler.ScriptKind.TS),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  session.service = compiler.createLanguageService(host);
  sessions.set(key, session);
  return session;
}

function siteOf(
  compiler: TypeScript,
  program: ts.Program | undefined,
  fileName: string,
  pos: number,
): { file: string; line: number; column: number } {
  const source = program?.getSourceFile(fileName);
  const at = source ? compiler.getLineAndCharacterOfPosition(source, pos) : { line: 0, character: 0 };
  return { file: fileName, line: at.line + 1, column: at.character + 1 };
}

function checkedTsPath(env: ComputerExecutionEnv, path: unknown, tool: string): string {
  if (typeof path !== "string" || path === "") {
    failKey("missingTsPath", { tool });
  }
  const file = normalizeWorkspacePath(path);
  let exists = false;
  try {
    env.readFile(file);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    failKey("noSuchFile", { path: file });
  }
  if (!isTs(file)) {
    failKey("badTsKind", { tool });
  }
  return file;
}

function readText(env: ComputerExecutionEnv, file: string): string {
  const text = decodeUtf8(env.readFile(file));
  if (text === null) {
    failKey("unreadableFile", { file });
  }
  return text as string;
}

export const diagnosticsCompilerTool: AgentHarnessTool<ToolContext, any, { files: number; errors: number }> = {
  name: "diagnostics",
  label: "Diagnostics",
  description:
    "Typecheck TypeScript with the compiler: syntactic plus semantic diagnostics as file:line:col rows with TS codes. Paths are workspace-relative posix; path takes one .ts file or a directory root (default the workspace root), limit caps rows (default 200). Cross-file programs resolve imports across the workspace. Read-only.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
    },
    required: [],
  },
  async execute(
    _id,
    params: { path?: string; limit?: number },
    _signal,
    _onUpdate,
    context,
  ): Promise<AgentToolResult<{ files: number; errors: number }>> {
    void _id;
    const limit = cappedLimit(params.limit, CAPS.diagDefault, Number.MAX_SAFE_INTEGER);
    const { files, scoped, skipped } = scopedTsFiles(context.env, params.path);
    let session: WorkspaceSession;
    try {
      session = serviceFor(context.env, await loadCompiler(), files);
    } catch {
      failKey("diagDown");
    }
    const compiler = session.compiler;
    const program = session.service.getProgram();
    const rows: string[] = [];
    for (const file of scoped) {
      if (skipped.includes(file)) {
        rows.push(`${file}: skipped (non-UTF8)`);
        continue;
      }
      const found = [
        ...session.service.getSyntacticDiagnostics(file),
        ...session.service.getSemanticDiagnostics(file),
      ];
      for (const diagnostic of found) {
        const at = siteOf(compiler, program, file, diagnostic.start ?? 0);
        rows.push(
          `${file}:${at.line}:${at.column}: TS${diagnostic.code}: ${compiler.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
        );
        if (rows.length >= limit) break;
      }
      if (rows.length >= limit) break;
    }
    const errors = rows.filter((row) => !row.includes("skipped (non-UTF8)")).length;
    if (rows.length === 0) {
      const noun = scoped.length === 1 ? "file" : "files";
      return {
        content: [{ type: "text", text: `(no issues in ${scoped.length} ${noun})` }],
        details: { files: scoped.length, errors: 0 },
      };
    }
    return {
      content: [{ type: "text", text: rows.join("\n") }],
      details: { files: scoped.length, errors },
    };
  },
};

export const definitionTool: AgentHarnessTool<
  ToolContext,
  any,
  { count: number; sites: Array<{ file: string; line: number; column: number }> }
> = {
  name: "definition",
  label: "Definition",
  description:
    "Jump to the definition of the symbol at a zero-based UTF-16 code-unit offset in a .ts or .tsx file. Paths are workspace-relative posix. Results are file:line:col rows (1-based). Unknown positions return no definition instead of failing. Read-only.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number" },
    },
    required: ["path", "offset"],
  },
  async execute(
    _id,
    params: { path?: string; offset?: number },
    _signal,
    _onUpdate,
    context,
  ): Promise<
    AgentToolResult<{ count: number; sites: Array<{ file: string; line: number; column: number }> }>
  > {
    void _id;
    const file = checkedTsPath(context.env, params.path, "definition");
    const text = readText(context.env, file);
    const offset = checkedTextOffset(params.offset, text, file);
    const { files } = workspaceTsFiles(context.env);
    const session = serviceFor(context.env, await loadCompiler(), files);
    const program = session.service.getProgram();
    const definitions = session.service.getDefinitionAndBoundSpan(file, offset)?.definitions ?? [];
    if (definitions.length === 0) {
      return {
        content: [{ type: "text", text: `(no definition at ${file}:${offset})` }],
        details: { count: 0, sites: [] },
      };
    }
    const sites = definitions.map((definition) =>
      siteOf(session.compiler, program, definition.fileName, definition.textSpan.start),
    );
    return {
      content: [{ type: "text", text: sites.map((at) => `${at.file}:${at.line}:${at.column}`).join("\n") }],
      details: { count: sites.length, sites },
    };
  },
};

export const referencesTool: AgentHarnessTool<
  ToolContext,
  any,
  { count: number; sites: Array<{ file: string; line: number; column: number }> }
> = {
  name: "references",
  label: "References",
  description:
    "List every reference to the symbol at a zero-based UTF-16 code-unit offset in a .ts or .tsx file, including its definition. Paths are workspace-relative posix. Results are file:line:col rows (1-based) ordered by file then position. Unknown positions return no references instead of failing. Read-only.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number" },
    },
    required: ["path", "offset"],
  },
  async execute(
    _id,
    params: { path?: string; offset?: number },
    _signal,
    _onUpdate,
    context,
  ): Promise<
    AgentToolResult<{ count: number; sites: Array<{ file: string; line: number; column: number }> }>
  > {
    void _id;
    const file = checkedTsPath(context.env, params.path, "references");
    const text = readText(context.env, file);
    const offset = checkedTextOffset(params.offset, text, file);
    const { files } = workspaceTsFiles(context.env);
    const session = serviceFor(context.env, await loadCompiler(), files);
    const program = session.service.getProgram();
    const symbols = session.service.findReferences(file, offset) ?? [];
    const sites = symbols
      .flatMap((symbol) =>
        symbol.references.map((reference) =>
          siteOf(session.compiler, program, reference.fileName, reference.textSpan.start),
        ),
      )
      .sort((a, b) => (a.file === b.file ? a.line - b.line || a.column - b.column : a.file < b.file ? -1 : 1));
    if (sites.length === 0) {
      return {
        content: [{ type: "text", text: `(no references to ${file}:${offset})` }],
        details: { count: 0, sites: [] },
      };
    }
    return {
      content: [{ type: "text", text: sites.map((at) => `${at.file}:${at.line}:${at.column}`).join("\n") }],
      details: { count: sites.length, sites },
    };
  },
};
