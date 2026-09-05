// shell-exec.ts — persistent shell sessions over Workers RPC.
//
// One Bash per sid, reused across exec calls so `export` and `cd`
// survive. just-bash scopes script mutations to a single exec, so the
// session keeps its own { env, cwd } and replays them per call: env
// from BashExecResult.env, cwd from its PWD entry. Sessions never touch
// VFS rows; the shell/filesystem join lands in PR27. Omit sid for the
// one-off path (fresh Bash, discarded when the run settles).
//
// Kill aborts the live run's AbortController; dispose drops the
// session. Timeouts and the 1MiB cap match the old one-off behavior.
import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash } from "just-bash";

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

function evictOldestIdle(sessions: Map<string, ExecSession>): never {
  let oldest: string | undefined;
  let oldestUsed = Infinity;
  for (const [sid, session] of sessions) {
    if (session.running !== null) continue;
    if (session.lastUsed < oldestUsed) {
      oldest = sid;
      oldestUsed = session.lastUsed;
    }
  }
  if (oldest === undefined) {
    throw new Error(
      `exec sessions full (${MAX_LIVE_SESSIONS} live, all running): kill or dispose one first`,
    );
  }
  sessions.delete(oldest);
  throw new Error(
    `exec sessions full (${MAX_LIVE_SESSIONS} live): disposed oldest idle session ${oldest} to make room, retry the command`,
  );
}

interface ExecSession {
  bash: Bash;
  env: Record<string, string>;
  cwd: string;
  running: AbortController | null;
  killRequested: boolean;
  lastUsed: number;
  stdoutBytes: number;
  stderrBytes: number;
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) : s;
}

function freshBash(): Bash {
  return new Bash({
    cwd: DEFAULT_CWD,
    // The isolate is the boundary; the in-isolate box needs
    // node:module hooks workerd lacks, so opt out (same call
    // refs/computer's entrypoint makes).
    defenseInDepth: { enabled: false },
    executionLimits: { maxOutputSize: MAX_OUTPUT_BYTES },
  });
}

const sessions = new Map<string, ExecSession>();
export const MAX_BG_PROCESSES = 64;
interface BgProcess {
  bash: Bash;
  controller: AbortController;
  done: boolean;
  result: ShellExecResult | null;
  startedAt: number;
  killRequested: boolean;
  timedOut: boolean;
}
const bgProcesses = new Map<string, BgProcess>();

export class ShellWorker<Env = unknown> extends WorkerEntrypoint<Env> {
  private sessions = sessions;

  override async fetch(): Promise<Response> {
    return new Response(
      "ShellWorker is invoked over Workers RPC — dispatch through getEntrypoint(\"ShellWorker\").",
      { status: 426, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  async exec(input: ShellExecInput): Promise<ShellExecResult> {
    const command = input?.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("exec needs a command string");
    }
    if (input.sid === undefined) return runOneOff(command, input.cwd, input.env);
    const sid = input.sid;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new Error("exec needs a session id string");
    }
    let session = this.sessions.get(sid);
    const cwd = resolveCwd(input.cwd, session?.cwd ?? DEFAULT_CWD);
    if (session === undefined) {
      if (this.sessions.size >= MAX_LIVE_SESSIONS) evictOldestIdle(this.sessions);
      session = { bash: freshBash(), env: {}, cwd: DEFAULT_CWD, running: null, killRequested: false, lastUsed: Date.now(), stdoutBytes: 0, stderrBytes: 0 };
      this.sessions.set(sid, session);
    }
    session.lastUsed = Date.now();
    if (session.running !== null) {
      throw new Error(`exec busy on session ${sid}: kill or wait before retrying`);
    }
    const controller = new AbortController();
    session.running = controller;
    session.killRequested = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Execution timed out"));
    }, EXEC_TIMEOUT_MS);
    try {
      const result = await session.bash.exec(command, {
        cwd,
        env: { ...session.env, ...input.env },
        signal: controller.signal,
      });
      if (timedOut || session.killRequested || controller.signal.aborted) {
        return aborted(session, timedOut);
      }
      session.stdoutBytes += new TextEncoder().encode(result.stdout).length;
      session.stderrBytes += new TextEncoder().encode(result.stderr).length;
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
      return {
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
        exit: result.exitCode,
        timedOut: false,
        killed: false,
      };
    } catch (error) {
      if (timedOut || session.killRequested || controller.signal.aborted) {
        return aborted(session, timedOut);
      }
      const message = error instanceof Error ? error.message : String(error);
      const stderr = truncate(`${message}\n`);
      session.stderrBytes += new TextEncoder().encode(stderr).length;
      return { stdout: "", stderr, exit: 1, timedOut: false, killed: false };
    } finally {
      clearTimeout(timer);
      if (session.running === controller) session.running = null;
    }
  }

  async kill(input: { sid: string }): Promise<{ killed: boolean }> {
    const sid = input?.sid;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new Error("kill needs a session id string");
    }
    const killSession = this.sessions.get(sid);
    if (killSession === undefined) {
      throw new Error(`no such exec session: ${sid}`);
    }
    if (killSession.running === null) return { killed: false };
    killSession.killRequested = true;
    killSession.running.abort(new Error("Execution killed"));
    return { killed: true };
  }

  async dispose(input: { sid: string }): Promise<DisposeResult> {
    const disposeSid = input?.sid;
    if (typeof disposeSid !== "string" || disposeSid.length === 0) {
      throw new Error("dispose needs a session id string");
    }
    const session = this.sessions.get(disposeSid);
    if (session !== undefined) {
      session.running?.abort(new Error("Session disposed"));
      this.sessions.delete(disposeSid);
      return { disposed: true, stdoutBytes: session.stdoutBytes, stderrBytes: session.stderrBytes };
    }
    return { disposed: true, stdoutBytes: 0, stderrBytes: 0 };
  }

  async bgStart(input: { command: string; cwd?: string; env?: Record<string, string> }): Promise<{ handle: string }> {
    const command = input?.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("bg needs a command string");
    }
    const cwd = resolveCwd(input.cwd, DEFAULT_CWD);
    if (bgProcesses.size >= MAX_BG_PROCESSES) {
      let oldest: string | undefined;
      let oldestStarted = Infinity;
      for (const [handle, entry] of bgProcesses) {
        if (!entry.done) continue;
        if (entry.startedAt < oldestStarted) {
          oldest = handle;
          oldestStarted = entry.startedAt;
        }
      }
      if (oldest === undefined) {
        throw new Error(`bg processes full (${MAX_BG_PROCESSES} live, all running): kill one first`);
      }
      bgProcesses.delete(oldest);
      throw new Error(`bg processes full (${MAX_BG_PROCESSES} live): disposed oldest done process ${oldest} to make room, retry the command`);
    }
    const handle = `bg-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const entry: BgProcess = { bash: freshBash(), controller, done: false, result: null, startedAt: Date.now(), killRequested: false, timedOut: false };
    bgProcesses.set(handle, entry);
    const timer = setTimeout(() => {
      entry.timedOut = true;
      controller.abort(new Error("Execution timed out"));
    }, EXEC_TIMEOUT_MS);
    void (async () => {
      try {
        const result = await entry.bash.exec(command, { cwd, env: input.env, signal: controller.signal });
        if (entry.timedOut || entry.killRequested || controller.signal.aborted) {
          entry.result = { stdout: "", stderr: "", exit: 124, timedOut: true, killed: entry.killRequested };
        } else {
          entry.result = { stdout: truncate(result.stdout), stderr: truncate(result.stderr), exit: result.exitCode, timedOut: false, killed: false };
        }
      } catch (error) {
        if (entry.timedOut || entry.killRequested || controller.signal.aborted) {
          entry.result = { stdout: "", stderr: "", exit: 124, timedOut: true, killed: entry.killRequested };
        } else {
          const message = error instanceof Error ? error.message : String(error);
          entry.result = { stdout: "", stderr: truncate(`${message}\n`), exit: 1, timedOut: false, killed: false };
        }
      } finally {
        clearTimeout(timer);
        entry.done = true;
      }
    })();
    return { handle };
  }
  async bgRead(input: { handle: string }): Promise<{ done: boolean; stdout?: string; stderr?: string; exit?: number; timedOut?: boolean; killed?: boolean }> {
    const handle = input?.handle;
    if (typeof handle !== "string" || handle.length === 0) {
      throw new Error("bg needs a handle string");
    }
    const entry = bgProcesses.get(handle);
    if (entry === undefined) {
      throw new Error(`no such bg process: ${handle}`);
    }
    if (!entry.done || entry.result === null) {
      return { done: false };
    }
    return { done: true, stdout: entry.result.stdout, stderr: entry.result.stderr, exit: entry.result.exit, timedOut: entry.result.timedOut, killed: entry.result.killed };
  }
  async bgKill(input: { handle: string }): Promise<{ killed: boolean }> {
    const handle = input?.handle;
    if (typeof handle !== "string" || handle.length === 0) {
      throw new Error("bg needs a handle string");
    }
    const entry = bgProcesses.get(handle);
    if (entry === undefined) {
      throw new Error(`no such bg process: ${handle}`);
    }
    if (!entry.done) {
      entry.killRequested = true;
      entry.controller.abort(new Error("Execution killed"));
      bgProcesses.delete(handle);
      return { killed: true };
    }
    bgProcesses.delete(handle);
    return { killed: false };
  }
}

function aborted(session: ExecSession, timedOut: boolean): ShellExecResult {
  const killed = session.killRequested;
  session.killRequested = false;
  return { stdout: "", stderr: "", exit: 124, timedOut: true, killed };
}

async function runOneOff(command: string, cwd?: string, env?: Record<string, string>): Promise<ShellExecResult> {
  const resolvedCwd = resolveCwd(cwd, DEFAULT_CWD);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Execution timed out"));
  }, EXEC_TIMEOUT_MS);
  try {
    const result = await freshBash().exec(command, {
      cwd: resolvedCwd,
      env,
      signal: controller.signal,
    });
    if (timedOut) {
      return { stdout: "", stderr: "", exit: 124, timedOut: true, killed: false };
    }
    return {
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      exit: result.exitCode,
      timedOut: false,
      killed: false,
    };
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      return { stdout: "", stderr: "", exit: 124, timedOut: true, killed: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: truncate(`${message}\n`), exit: 1, timedOut: false, killed: false };
  } finally {
    clearTimeout(timer);
  }
}
