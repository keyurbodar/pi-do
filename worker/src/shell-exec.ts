import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash } from "just-bash";
import { AsyncKeyMutex, execAborted, execEnd, mapBounded, withTimeoutSignal, type TimeoutScope } from "./async-util";

export interface ShellExecInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  sid?: string;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exit: number;
  timedOut: boolean;
  killed: boolean;
}

export const DEFAULT_CWD = "/workspace";
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const EXEC_TIMEOUT_MS = 10_000;
export const MAX_LIVE_SESSIONS = 64;
export const MAX_BG_PROCESSES = 64;
const WORKSPACE_ROOT = DEFAULT_CWD;

export interface DisposeResult {
  disposed: true;
  stdoutBytes: number;
  stderrBytes: number;
}

function resolveCwd(requested: string | undefined, base: string): string {
  const raw = requested ?? base;
  const abs = raw.startsWith("/") ? raw : `${base}/${raw}`;
  const out: string[] = [];
  for (const part of abs.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const resolved = `/${out.join("/")}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`exec cwd escapes the workspace root (${WORKSPACE_ROOT}): ${raw}`);
  }
  return resolved;
}

interface ExecSession {
  bash: Bash;
  env: Record<string, string>;
  cwd: string;
  current: TimeoutScope | null;
  killRequested: boolean;
  lastUsed: number;
  stdoutBytes: number;
  stderrBytes: number;
}

interface BgProcess {
  bash: Bash;
  scope: TimeoutScope;
  done: boolean;
  result: ShellExecResult | null;
  startedAt: number;
  killRequested: boolean;
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) : s;
}

function freshBash(): Bash {
  return new Bash({ cwd: DEFAULT_CWD, defenseInDepth: { enabled: false }, executionLimits: { maxOutputSize: MAX_OUTPUT_BYTES } });
}

function aborted(session: ExecSession): ShellExecResult {
  const killed = session.killRequested;
  session.killRequested = false;
  return execEnd(killed);
}

const sessions = new Map<string, ExecSession>();
const bgProcesses = new Map<string, BgProcess>();
const locks = new AsyncKeyMutex();

export class ShellWorker<Env = unknown> extends WorkerEntrypoint<Env> {
  private sessions = sessions;

  override async fetch(): Promise<Response> {
    return new Response("ShellWorker is invoked over Workers RPC — dispatch through getEntrypoint(\"ShellWorker\").", {
      status: 426,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  async exec(input: ShellExecInput): Promise<ShellExecResult> {
    const command = input?.command;
    if (typeof command !== "string" || command.length === 0) throw new Error("exec needs a command string");
    if (input.sid === undefined) return runOneOff(command, input.cwd, input.env);
    const sid = input.sid;
    if (typeof sid !== "string" || sid.length === 0) throw new Error("exec needs a session id string");
    return locks.withLock(sid, () => this.runSessionTurn(sid, command, input.cwd, input.env));
  }

  private async runSessionTurn(sid: string, command: string, requestedCwd: string | undefined, extraEnv: Record<string, string> | undefined): Promise<ShellExecResult> {
    let session = this.sessions.get(sid);
    session ??= mapBounded(this.sessions, sid, () => ({ bash: freshBash(), env: {}, cwd: DEFAULT_CWD, current: null, killRequested: false, lastUsed: Date.now(), stdoutBytes: 0, stderrBytes: 0 }), (s) => (s.current !== null ? null : s.lastUsed), MAX_LIVE_SESSIONS, `exec sessions full (${MAX_LIVE_SESSIONS} live, all running): kill or dispose one first`);
    const cwd = resolveCwd(requestedCwd, session.cwd);
    session.lastUsed = Date.now();
    const scope = withTimeoutSignal(EXEC_TIMEOUT_MS);
    session.current = scope;
    session.killRequested = false;
    const enc = new TextEncoder();
    try {
      const result = await session.bash.exec(command, { cwd, env: { ...session.env, ...extraEnv }, signal: scope.signal });
      if (execAborted(scope, session.killRequested)) return aborted(session);
      session.stdoutBytes += enc.encode(result.stdout).length;
      session.stderrBytes += enc.encode(result.stderr).length;
      if (result.env !== undefined) {
        session.env = { ...result.env };
        const pwd = result.env["PWD"];
        if (typeof pwd === "string" && pwd.startsWith("/")) {
          try {
            session.cwd = resolveCwd(pwd, session.cwd);
          } catch {
            session.cwd = DEFAULT_CWD;
          }
        }
      }
      return { stdout: truncate(result.stdout), stderr: truncate(result.stderr), exit: result.exitCode, timedOut: false, killed: false };
    } catch (error) {
      if (execAborted(scope, session.killRequested)) return aborted(session);
      const message = error instanceof Error ? error.message : String(error);
      const stderr = truncate(`${message}\n`);
      session.stderrBytes += enc.encode(stderr).length;
      return { stdout: "", stderr, exit: 1, timedOut: false, killed: false };
    } finally {
      scope.dispose();
      if (session.current === scope) session.current = null;
    }
  }

  async kill(input: { sid: string }): Promise<{ killed: boolean }> {
    const sid = input?.sid;
    if (typeof sid !== "string" || sid.length === 0) throw new Error("kill needs a session id string");
    const session = this.sessions.get(sid);
    if (session === undefined) throw new Error(`no such exec session: ${sid}`);
    if (session.current === null) return { killed: false };
    session.killRequested = true;
    session.current.controller.abort(new Error("Execution killed"));
    return { killed: true };
  }

  async dispose(input: { sid: string }): Promise<DisposeResult> {
    const sid = input?.sid;
    if (typeof sid !== "string" || sid.length === 0) throw new Error("dispose needs a session id string");
    const session = this.sessions.get(sid);
    if (session === undefined) return { disposed: true, stdoutBytes: 0, stderrBytes: 0 };
    session.current?.controller.abort(new Error("Session disposed"));
    this.sessions.delete(sid);
    return { disposed: true, stdoutBytes: session.stdoutBytes, stderrBytes: session.stderrBytes };
  }

  async bgStart(input: { command: string; cwd?: string; env?: Record<string, string> }): Promise<{ handle: string }> {
    const command = input?.command;
    if (typeof command !== "string" || command.length === 0) throw new Error("bg needs a command string");
    const cwd = resolveCwd(input.cwd, DEFAULT_CWD);
    const handle = `bg-${crypto.randomUUID()}`;
    const scope = withTimeoutSignal(EXEC_TIMEOUT_MS);
    const entry: BgProcess = { bash: freshBash(), scope, done: false, result: null, startedAt: Date.now(), killRequested: false };
    mapBounded(bgProcesses, handle, () => entry, (e) => (e.done ? e.startedAt : null), MAX_BG_PROCESSES, `bg processes full (${MAX_BG_PROCESSES} live, all running): kill one first`);
    void (async () => {
      try {
        const result = await entry.bash.exec(command, { cwd, env: input.env, signal: scope.signal });
        entry.result ??= execAborted(scope, entry.killRequested)
          ? execEnd(entry.killRequested)
          : { stdout: truncate(result.stdout), stderr: truncate(result.stderr), exit: result.exitCode, timedOut: false, killed: false };
      } catch (error) {
        entry.result ??= execAborted(scope, entry.killRequested)
          ? execEnd(entry.killRequested)
          : { stdout: "", stderr: truncate(`${error instanceof Error ? error.message : String(error)}\n`), exit: 1, timedOut: false, killed: false };
      } finally {
        scope.dispose();
        entry.done = true;
      }
    })();
    return { handle };
  }

  async bgRead(input: { handle: string }): Promise<{ done: boolean; stdout?: string; stderr?: string; exit?: number; timedOut?: boolean; killed?: boolean }> {
    const handle = input?.handle;
    if (typeof handle !== "string" || handle.length === 0) throw new Error("bg needs a handle string");
    const entry = bgProcesses.get(handle);
    if (entry === undefined) throw new Error(`no such bg process: ${handle}`);
    if (!entry.done || entry.result === null) return { done: false };
    const out = { done: true, stdout: entry.result.stdout, stderr: entry.result.stderr, exit: entry.result.exit, timedOut: entry.result.timedOut, killed: entry.result.killed };
    if (entry.killRequested) bgProcesses.delete(handle);
    return out;
  }

  async bgKill(input: { handle: string }): Promise<{ killed: boolean }> {
    const handle = input?.handle;
    if (typeof handle !== "string" || handle.length === 0) throw new Error("bg needs a handle string");
    const entry = bgProcesses.get(handle);
    if (entry === undefined) throw new Error(`no such bg process: ${handle}`);
    if (!entry.done) {
      entry.killRequested = true;
      entry.scope.dispose();
      entry.scope.controller.abort(new Error("Execution killed"));
      entry.result = execEnd(true);
      entry.done = true;
      return { killed: true };
    }
    bgProcesses.delete(handle);
    return { killed: false };
  }
}

async function runOneOff(command: string, cwd?: string, env?: Record<string, string>): Promise<ShellExecResult> {
  const resolvedCwd = resolveCwd(cwd, DEFAULT_CWD);
  const scope = withTimeoutSignal(EXEC_TIMEOUT_MS);
  try {
    const result = await freshBash().exec(command, { cwd: resolvedCwd, env, signal: scope.signal });
    if (execAborted(scope, false)) return execEnd(false);
    return { stdout: truncate(result.stdout), stderr: truncate(result.stderr), exit: result.exitCode, timedOut: false, killed: false };
  } catch (error) {
    if (execAborted(scope, false)) return execEnd(false);
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: truncate(`${message}\n`), exit: 1, timedOut: false, killed: false };
  } finally {
    scope.dispose();
  }
}
