import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash } from "just-bash";
import { AsyncKeyMutex, execAborted, execEnd, mapBounded, withTimeoutSignal, type TimeoutScope } from "./async-util";

export interface ShellExecInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  sid?: string;
  timeout?: number;
  root?: string;
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
export const MAX_EXEC_TIMEOUT_MS = 120_000;
export const BG_TIMEOUT_MS = 600_000;
export const MAX_LIVE_SESSIONS = 64;
export const MAX_BG_PROCESSES = 64;
const WORKSPACE_ROOT = DEFAULT_CWD;

export interface DisposeResult {
  disposed: true;
  stdoutBytes: number;
  stderrBytes: number;
}
export type StaleHandleCode = "stale-exec-session" | "stale-bg-process";

// Unknown handles are stale post-restart handles: an isolate restart wipes the
// maps below, so name the restart instead of a bare "no such".
export class StaleHandleError extends Error {
  readonly code: StaleHandleCode;
  readonly hint: string;
  constructor(code: StaleHandleCode, message: string, hint: string) {
    super(message);
    this.name = "StaleHandleError";
    this.code = code;
    this.hint = hint;
  }
}

function staleSession(sid: string): StaleHandleError {
  return new StaleHandleError(
    "stale-exec-session",
    `no such exec session: ${sid} (isolate restarted or sid never used: shell sessions do not survive restarts; run one command with that sid to recreate it)`,
    "run one command with that sid first to create the session",
  );
}

function staleBg(handle: string): StaleHandleError {
  return new StaleHandleError(
    "stale-bg-process",
    `no such bg process: ${handle} (isolate restarted or handle already reaped: shell handles do not survive restarts; start a new one to respawn it)`,
    "start one with POST /workspaces/:id/bg first, or it was killed",
  );
}

function resolveRoot(raw: string | undefined): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return WORKSPACE_ROOT;
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const resolved = `/${out.join("/")}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`exec root escapes the workspace root (${WORKSPACE_ROOT}): ${raw}`);
  }
  return resolved;
}

function resolveCwd(requested: string | undefined, base: string, root: string = WORKSPACE_ROOT): string {
  const raw = requested ?? base;
  const abs = raw.startsWith("/") ? raw : `${base}/${raw}`;
  const out: string[] = [];
  for (const part of abs.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const resolved = `/${out.join("/")}`;
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    const scope = root === WORKSPACE_ROOT ? "workspace root" : "session root";
    throw new Error(`exec cwd escapes the ${scope} (${root}): ${raw}`);
  }
  return resolved;
}

interface ExecSession {
  bash: Bash;
  env: Record<string, string>;
  cwd: string;
  root: string;
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

function resolveTimeoutMs(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return EXEC_TIMEOUT_MS;
  return Math.min(requested, MAX_EXEC_TIMEOUT_MS);
}


function callerAborted(scope: TimeoutScope, killRequested: boolean): boolean {
  return execAborted(scope, killRequested) && !scope.timedOut() && !killRequested;
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
    if (input.sid === undefined) return runOneOff(command, input.cwd, input.env, input.timeout, input.root);
    const sid = input.sid;
    if (typeof sid !== "string" || sid.length === 0) throw new Error("exec needs a session id string");
    return locks.withLock(sid, () => this.runSessionTurn(sid, command, input.cwd, input.env, input.timeout, input.root));
  }

  private async runSessionTurn(
    sid: string,
    command: string,
    requestedCwd: string | undefined,
    extraEnv: Record<string, string> | undefined,
    requestedTimeout: number | undefined,
    requestedRoot: string | undefined,
  ): Promise<ShellExecResult> {
    let session = this.sessions.get(sid);
    if (session === undefined) {
      if (this.sessions.size >= MAX_LIVE_SESSIONS) {
        const disposed = this.disposeOldestIdleSession();
        if (disposed !== undefined) {
          throw new Error(`exec sessions full (${MAX_LIVE_SESSIONS} live): disposed oldest-idle session ${disposed}; kill or dispose one first`);
        }
        throw new Error(`exec sessions full (${MAX_LIVE_SESSIONS} live, all running): kill or dispose one first`);
      }
      const root = resolveRoot(requestedRoot);
      session = { bash: freshBash(), env: {}, cwd: root, root, current: null, killRequested: false, lastUsed: Date.now(), stdoutBytes: 0, stderrBytes: 0 };
      this.sessions.set(sid, session);
    }
    const cwd = resolveCwd(requestedCwd, session.cwd, session.root);
    session.lastUsed = Date.now();
    const scope = withTimeoutSignal(resolveTimeoutMs(requestedTimeout));
    session.current = scope;
    session.killRequested = false;
    const enc = new TextEncoder();
    try {
      const result = await session.bash.exec(command, { cwd, env: { ...session.env, ...extraEnv }, signal: scope.signal });
      if (callerAborted(scope, session.killRequested)) {
        return { stdout: "", stderr: "", exit: 124, timedOut: false, killed: true };
      }
      if (execAborted(scope, session.killRequested)) return aborted(session);
      session.stdoutBytes += enc.encode(result.stdout).length;
      session.stderrBytes += enc.encode(result.stderr).length;
      if (result.env !== undefined) {
        session.env = { ...result.env };
        const pwd = result.env["PWD"];
        if (typeof pwd === "string" && pwd.startsWith("/")) {
          try {
            session.cwd = resolveCwd(pwd, session.cwd, session.root);
          } catch {
            session.cwd = session.root;
          }
        }
      }
      return { stdout: truncate(result.stdout), stderr: truncate(result.stderr), exit: result.exitCode, timedOut: false, killed: false };
    } catch (error) {
      if (callerAborted(scope, session.killRequested)) {
        return { stdout: "", stderr: "", exit: 124, timedOut: false, killed: true };
      }
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
    if (session === undefined) throw staleSession(sid);
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

  private disposeOldestIdleSession(): string | undefined {
    let oldestSid: string | undefined;
    let oldestIdle = Infinity;
    for (const [key, session] of this.sessions) {
      if (session.current !== null || session.lastUsed >= oldestIdle) continue;
      oldestSid = key;
      oldestIdle = session.lastUsed;
    }
    if (oldestSid === undefined) return undefined;
    const victim = this.sessions.get(oldestSid);
    victim?.current?.controller.abort(new Error("Session disposed"));
    this.sessions.delete(oldestSid);
    return oldestSid;
  }

  async bgStart(input: { command: string; cwd?: string; env?: Record<string, string>; root?: string }): Promise<{ handle: string }> {
    const command = input?.command;
    if (typeof command !== "string" || command.length === 0) throw new Error("bg needs a command string");
    const root = resolveRoot(input.root);
    const cwd = resolveCwd(input.cwd, root, root);
    const handle = `bg-${crypto.randomUUID()}`;
    const scope = withTimeoutSignal(BG_TIMEOUT_MS);
    const entry: BgProcess = { bash: freshBash(), scope, done: false, result: null, startedAt: Date.now(), killRequested: false };
    mapBounded(bgProcesses, handle, () => entry, (e) => (e.done ? e.startedAt : null), MAX_BG_PROCESSES, `bg processes full (${MAX_BG_PROCESSES} live, all running): kill one first`);
    void (async () => {
      try {
        const running = entry.bash.exec(command, { cwd, env: input.env, signal: scope.signal });
        // bgKill aborts this scope and pre-sets entry.result; the rejection of a
        // pending exec must never float — consume it here on top of the await below.
        running.catch(() => {});
        const result = await running;
        entry.result ??= execAborted(scope, entry.killRequested)
          ? execEnd(entry.killRequested)
          : { stdout: truncate(result.stdout), stderr: truncate(result.stderr), exit: result.exitCode, timedOut: false, killed: false };
      } catch (error) {
        // A just-bash internal throw after abort (poisoned scope reads) lands here
        // and must surface as the structured killed result, not an uncaught error.
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
    if (entry === undefined) throw staleBg(handle);
    if (!entry.done || entry.result === null) return { done: false };
    const out = { done: true, stdout: entry.result.stdout, stderr: entry.result.stderr, exit: entry.result.exit, timedOut: entry.result.timedOut, killed: entry.result.killed };
    if (entry.killRequested) bgProcesses.delete(handle);
    return out;
  }

  async bgKill(input: { handle: string }): Promise<{ killed: boolean }> {
    const handle = input?.handle;
    if (typeof handle !== "string" || handle.length === 0) throw new Error("bg needs a handle string");
    const entry = bgProcesses.get(handle);
    if (entry === undefined) throw staleBg(handle);
    if (!entry.done) {
      entry.killRequested = true;
      entry.scope.dispose();
      // Abort listener dispatch runs just-bash teardown synchronously; a throw there
      // must not escape bgKill — the signal is already aborted and the killed result
      // is recorded below regardless.
      try {
        entry.scope.controller.abort(new Error("Execution killed"));
      } catch {
        // signal is already aborted at this point; nothing to recover
      }
      entry.result = execEnd(true);
      entry.done = true;
      return { killed: true };
    }
    bgProcesses.delete(handle);
    return { killed: false };
  }
}

async function runOneOff(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
  requestedTimeout?: number,
  requestedRoot?: string,
): Promise<ShellExecResult> {
  const root = resolveRoot(requestedRoot);
  const resolvedCwd = resolveCwd(cwd, root, root);
  const scope = withTimeoutSignal(resolveTimeoutMs(requestedTimeout));
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
