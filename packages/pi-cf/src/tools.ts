import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionEnv,
  FileInfo,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import {
  ExecutionError,
  FileError,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  err,
  ok,
} from "@earendil-works/pi-agent-core";
import { ComputerExecutionEnv } from "./env.ts";
import type { Edit } from "./edit-diff.ts";
import {
  CAPS,
  cappedLimit,
  checkedLimit,
  checkedOffset,
  decodeUtf8,
  failKey,
  normalizeWorkspacePath,
} from "./validate.ts";
export { normalizeWorkspacePath };

export interface ToolContext {
  env: ComputerExecutionEnv;
}

export function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

export const MAX_READ_LINES = CAPS.readLines;
export const MAX_READ_BYTES = CAPS.readBytes;
export const LIST_DEFAULT_MAX_ENTRIES = CAPS.listDefault;
export const LIST_HARD_MAX_ENTRIES = CAPS.listHard;

class CfEnv implements ExecutionEnv {
  cwd = "";
  lastFailure: { error: string; hint: string } | undefined;
  private inner: ComputerExecutionEnv;
  private temps = new Map<string, string>();
  private tempSeq = 0;
  constructor(inner: ComputerExecutionEnv) {
    this.inner = inner;
  }

  private toFileError(e: unknown, path: string): FileError {
    if (e !== null && typeof e === "object" && "error" in e && typeof (e as { error: unknown }).error === "string") {
      const message = String((e as { error: unknown }).error);
      return new FileError(message.includes("no such file") ? "not_found" : "unknown", message, path);
    }
    return new FileError("unknown", e instanceof Error ? e.message : String(e), path);
  }

  private baseOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
  }

  async absolutePath(path: string, _signal?: AbortSignal) {
    try {
      return ok<string, FileError>(normalizeWorkspacePath(path));
    } catch (e) {
      const message =
        e !== null && typeof e === "object" && "error" in e ? String((e as { error: unknown }).error) : "bad path";
      return err<string, FileError>(new FileError("invalid", message, path));
    }
  }

  async joinPath(parts: string[], _signal?: AbortSignal) {
    return ok<string, FileError>(parts.filter((p) => p !== "").join("/"));
  }

  async readBinaryFile(path: string, _signal?: AbortSignal) {
    try {
      return ok<Uint8Array, FileError>(this.inner.readFile(path));
    } catch (e) {
      return err<Uint8Array, FileError>(this.toFileError(e, path));
    }
  }

  async readTextFile(path: string, signal?: AbortSignal) {
    const bin = await this.readBinaryFile(path, signal);
    if (!bin.ok) return err<string, FileError>(bin.error);
    const text = decodeUtf8(bin.value);
    if (text === null) return err<string, FileError>(new FileError("invalid", `unreadable file: ${path}`, path));
    return ok<string, FileError>(text);
  }

  async readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }) {
    const text = await this.readTextFile(path, options?.abortSignal);
    if (!text.ok) return err<string[], FileError>(text.error);
    const lines = text.value.split("\n");
    return ok<string[], FileError>(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async writeFile(path: string, content: string | Uint8Array, _signal?: AbortSignal) {
    try {
      this.inner.writeFile(path, content);
      return ok<void, FileError>(undefined);
    } catch (e) {
      return err<void, FileError>(this.toFileError(e, path));
    }
  }

  async appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal) {
    const chunk = typeof content === "string" ? content : new TextDecoder().decode(content);
    if (this.temps.has(path)) {
      this.temps.set(path, (this.temps.get(path) ?? "") + chunk);
      return ok<void, FileError>(undefined);
    }
    const cur = await this.readBinaryFile(path, signal);
    if (!cur.ok) {
      if (cur.error.code === "not_found") return this.writeFile(path, chunk, signal);
      return err<void, FileError>(cur.error);
    }
    const encoded = new TextEncoder().encode(chunk);
    const next = new Uint8Array(cur.value.byteLength + encoded.byteLength);
    next.set(cur.value, 0);
    next.set(encoded, cur.value.byteLength);
    return this.writeFile(path, next, signal);
  }

  async renameFile(sourcePath: string, _destination: string, _signal?: AbortSignal) {
    return err<void, FileError>(new FileError("not_supported", `rename unsupported: ${sourcePath}`, sourcePath));
  }

  async fileInfo(path: string, _signal?: AbortSignal) {
    const clean = path.replace(/\/+$/, "");
    const info = (kind: FileInfo["kind"], size: number): FileInfo => ({
      name: clean === "" ? "" : this.baseOf(clean),
      path: clean,
      kind,
      size,
      mtimeMs: Date.now(),
    });
    try {
      const bytes = this.inner.readFile(clean);
      return ok<FileInfo, FileError>(info("file", bytes.byteLength));
    } catch {
      if (clean === "" || this.inner.readdir(`${clean}/`).length > 0) return ok<FileInfo, FileError>(info("directory", 0));
      return err<FileInfo, FileError>(new FileError("not_found", `no such file: ${path}`, path));
    }
  }

  async listDir(path: string, _signal?: AbortSignal) {
    return err<FileInfo[], FileError>(new FileError("not_supported", `listing unsupported: ${path}`, path));
  }

  async canonicalPath(path: string, _signal?: AbortSignal) {
    return err<string, FileError>(new FileError("not_supported", `canonical paths unsupported: ${path}`, path));
  }

  async exists(path: string, _signal?: AbortSignal) {
    try {
      this.inner.readFile(path);
      return ok<boolean, FileError>(true);
    } catch {
      if (path === "") return ok<boolean, FileError>(true);
      return ok<boolean, FileError>(this.inner.readdir(`${path.replace(/\/+$/, "")}/`).length > 0);
    }
  }

  async createDir(_path: string, _options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
    return ok<void, FileError>(undefined);
  }

  async remove(path: string, _options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }) {
    return err<void, FileError>(new FileError("not_supported", `remove unsupported: ${path}`, path));
  }

  async createTempDir(prefix?: string, _signal?: AbortSignal) {
    return ok<string, FileError>(`tmp/${prefix ?? "tmp-"}`);
  }

  async createTempFile(options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }) {
    this.tempSeq += 1;
    const name = `tmp/${options?.prefix ?? "tmp-"}${Date.now().toString(36)}-${this.tempSeq}${options?.suffix ?? ""}`;
    this.temps.set(name, "");
    return ok<string, FileError>(name);
  }

  async cleanup(): Promise<void> {}

  async exec(command: string, options?: ShellExecOptions) {
    type ExecOut = { stdout: string; stderr: string; exitCode: number };
    if (options?.abortSignal?.aborted) return err<ExecOut, ExecutionError>(new ExecutionError("aborted", "aborted"));
    try {
      const out = await this.inner.exec(command, options?.cwd);
      options?.onStdout?.(out.stdout);
      options?.onStderr?.(out.stderr);
      return ok<ExecOut, ExecutionError>({ stdout: out.stdout, stderr: out.stderr, exitCode: out.exit });
    } catch (e) {
      if (e !== null && typeof e === "object" && "error" in e && typeof (e as { error: unknown }).error === "string") {
        const error = String((e as { error: unknown }).error);
        const hint =
          "hint" in e && typeof (e as { hint: unknown }).hint === "string" ? String((e as { hint: unknown }).hint) : "";
        this.lastFailure = { error, hint };
        const code = error.includes("timed out")
          ? "timeout"
          : error.includes("shell unavailable")
            ? "shell_unavailable"
            : "unknown";
        return err<ExecOut, ExecutionError>(new ExecutionError(code, hint ? `${error}: ${hint}` : error));
      }
      return err<ExecOut, ExecutionError>(new ExecutionError("unknown", e instanceof Error ? e.message : String(e)));
    }
  }
}

const bridges = new WeakMap<ComputerExecutionEnv, CfEnv>();

function bridgeFor(env: ComputerExecutionEnv): CfEnv {
  let bridge = bridges.get(env);
  if (bridge === undefined) {
    bridge = new CfEnv(env);
    bridges.set(env, bridge);
  }
  return bridge;
}

type MutationState = { queues: Map<string, Promise<void>>; registration: Promise<void> };
const mutationStates = new WeakMap<object, MutationState>();

export function withFileMutationQueue<T>(env: ComputerExecutionEnv, path: string, fn: () => Promise<T>): Promise<T> {
  let state = mutationStates.get(env);
  if (state === undefined) {
    state = { queues: new Map(), registration: Promise.resolve() };
    mutationStates.set(env, state);
  }
  const current = state;
  const registration = current.registration.then(async () => {
    const prev = current.queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    current.queues.set(path, chained);
    return { prev, chained, release };
  });
  current.registration = registration.then(
    () => undefined,
    () => undefined,
  );
  return registration.then(({ prev, chained, release }) =>
    prev.then(fn).finally(() => {
      release();
      if (current.queues.get(path) === chained) current.queues.delete(path);
    }),
  );
}

function toolFailure(e: unknown, path: string, env?: CfEnv): never {
  if (e !== null && typeof e === "object" && "error" in e && typeof (e as { error: unknown }).error === "string") {
    throw e;
  }
  if (e instanceof FileError) {
    if (e.code === "not_found") failKey("noSuchFile", { path });
    failKey("upstream", { message: e.message.slice(0, 300) });
  }
  if (e instanceof ExecutionError) {
    const prior = env?.lastFailure;
    if (prior !== undefined) throw prior;
    failKey("upstream", { message: e.message.slice(0, 300) });
  }
  if (e instanceof Error) {
    const offset = e.message.match(/^Offset (\d+) is beyond end of file \((\d+) lines total\)/);
    if (offset !== null) failKey("offsetBeyond", { start: offset[1], total: offset[2] });
    if (e.message.startsWith("Could not edit file:")) failKey("noSuchFile", { path });
    failKey("upstream", { message: e.message.slice(0, 300) });
  }
  failKey("upstream", { message: String(e).slice(0, 300) });
}

function keepReadFooter(
  text: string,
  env: ComputerExecutionEnv,
  path: string,
  offset: number | undefined,
  limit: number | undefined,
): string {
  const out = text.replace(/ \([0-9.]+[KMGT]?B limit\)\. Use offset=/, ". Use offset=");
  const more = out.match(/\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]\s*$/);
  if (more === null || (offset === undefined && limit === undefined)) return out;
  let total = 0;
  try {
    total = new TextDecoder().decode(env.readFile(path)).split("\n").length;
  } catch {
    return out;
  }
  const body = out.slice(0, more.index ?? out.length).replace(/\s+$/, "");
  const start = offset ?? 1;
  const end = start + body.split("\n").length - 1;
  return `${body}\n\n[Showing lines ${start}-${end} of ${total}. Use offset=${more[2]} to continue.]`;
}

function normalizeEdits(input: unknown): Edit[] {
  const record = (input ?? {}) as Record<string, unknown>;
  let raw = record["edits"];
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      failKey("badEdits");
    }
  }
  const edits: Edit[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) failKey("badEditAt", { i });
      const rec = entry as Record<string, unknown>;
      if (typeof rec["oldText"] !== "string") failKey("badEditOld", { i });
      if (typeof rec["newText"] !== "string") failKey("badEditNew", { i });
      edits.push({ oldText: rec["oldText"] as string, newText: rec["newText"] as string });
    });
  }
  const oldText = record["oldText"];
  const newText = record["newText"];
  if (oldText !== undefined || newText !== undefined) {
    if (typeof oldText !== "string") failKey("badOldText");
    if (typeof newText !== "string") failKey("badNewText");
    edits.push({ oldText: oldText as string, newText: newText as string });
  }
  if (edits.length === 0) {
    failKey("missingEdits");
  }
  return edits;
}

const readInner = createReadTool();
const writeInner = createWriteTool();
const editInner = createEditTool();
const bashInner = createBashTool();

export const readTool: AgentHarnessTool<ToolContext, any, { bytes: number }> = {
  name: readInner.name,
  label: readInner.label,
  description: readInner.description,
  parameters: readInner.parameters,
  async execute(
    id,
    params: { path: string; offset?: number; limit?: number },
    signal,
    _onUpdate,
    context,
  ) {
    const path = normalizeWorkspacePath(params.path);
    const offset = checkedOffset(params.offset);
    const limit = checkedLimit(params.limit, "limit");
    const env = bridgeFor(context.env);
    let out: { content: Array<{ type: string; text?: string }> };
    try {
      out = (await readInner.execute(id, { path, offset, limit }, signal, undefined, { env })) as unknown as typeof out;
    } catch (e) {
      toolFailure(e, path, env);
    }
    const text = out.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
    const kept = keepReadFooter(text, context.env, path, offset, limit);
    const content: AgentToolResult<{ bytes: number }>["content"] =
      kept === text ? (out.content as AgentToolResult<{ bytes: number }>["content"]) : [{ type: "text", text: kept }];
    return { content, details: { bytes: context.env.stat(path).bytes } };
  },
};

export const writeTool: AgentHarnessTool<ToolContext, any, { bytes: number }> = {
  name: writeInner.name,
  label: writeInner.label,
  description: writeInner.description,
  parameters: writeInner.parameters,
  async execute(id, params: { path: string; content: string }, signal, _onUpdate, context) {
    const path = normalizeWorkspacePath(params.path);
    if (typeof params.content !== "string") {
      failKey("badContent");
    }
    const env = bridgeFor(context.env);
    type WriteExec = (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      context: { env: CfEnv },
    ) => Promise<unknown>;
    try {
      await withFileMutationQueue(context.env, path, () =>
        (writeInner.execute as unknown as WriteExec)(id, { path, content: params.content }, signal, undefined, { env }),
      );
    } catch (e) {
      toolFailure(e, path, env);
    }
    return {
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
      details: { bytes: new TextEncoder().encode(params.content).byteLength },
    };
  },
};

export const editTool: AgentHarnessTool<
  ToolContext,
  any,
  { diff: string; patch: string; firstChangedLine?: number }
> = {
  name: editInner.name,
  label: editInner.label,
  description: editInner.description,
  parameters: editInner.parameters,
  async execute(id, params: unknown, signal, _onUpdate, context) {
    const record = (params ?? {}) as Record<string, unknown>;
    const path = normalizeWorkspacePath(record["path"]);
    const edits = normalizeEdits(params);
    const env = bridgeFor(context.env);
    try {
      return (await withFileMutationQueue(context.env, path, () =>
        (
          editInner.execute as unknown as (
            id: string,
            params: unknown,
            signal: AbortSignal | undefined,
            onUpdate: undefined,
            context: { env: CfEnv },
          ) => Promise<{
            content: Array<{ type: string; text?: string }>;
            details: { diff: string; patch: string; firstChangedLine?: number };
          }>
        )(id, { path, edits }, signal, undefined, { env }),
      )) as unknown as {
        content: Array<{ type: "text"; text: string }>;
        details: { diff: string; patch: string; firstChangedLine?: number };
      };
    } catch (e) {
      if (e instanceof Error && !e.message.startsWith("Could not edit file:")) {
        failKey("editFailed", { message: e.message });
      }
      toolFailure(e, path, env);
    }
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
    void id;
    const dir = params.path === undefined || params.path === "" ? "" : normalizeWorkspacePath(params.path);
    const recursive = params.recursive ?? false;
    const maxEntries = cappedLimit(params.maxEntries, LIST_DEFAULT_MAX_ENTRIES, LIST_HARD_MAX_ENTRIES, "maxEntries", "entriesLarge");
    const prefix = dir === "" ? "" : `${dir}/`;
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
    const out = names.slice(0, maxEntries);
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
    void id;
    const path = normalizeWorkspacePath(params.path);
    if (path === "") {
      failKey("removeRoot");
    }
    const recursive = params.recursive ?? false;
    const prefix = `${path}/`;
    return withFileMutationQueue(context.env, path, async () => {
      let removed: string[] = [];
      try {
        context.env.readFile(path);
        context.env.rm(path);
        removed = [path];
      } catch {
        const under = context.env.readdir(prefix).map((e) => e.path);
        if (under.length === 0) {
          failKey("noSuchFile", { path });
        }
        if (!recursive) {
          failKey("isDirectory", { path });
        }
        for (const p of under) {
          await withFileMutationQueue(context.env, p, async () => context.env.rm(p));
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
  async execute(id, params: { command: string; timeout?: number }, signal, _onUpdate, context) {
    const env = bridgeFor(context.env);
    type BashExec = (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      context: { env: CfEnv },
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
    try {
      const out = await (bashInner.execute as unknown as BashExec)(
        id,
        { command: params.command, timeout: params.timeout },
        signal,
        undefined,
        { env },
      );
      return { content: out.content, details: { exit: 0 } };
    } catch (e) {
      if (e instanceof Error) {
        const code = e.message.match(/Command exited with code (\d+)/);
        if (code !== null) {
          return { content: [{ type: "text", text: e.message }], details: { exit: Number(code[1]) } };
        }
      }
      toolFailure(e, typeof params.command === "string" ? params.command : "", env);
    }
  },
};
