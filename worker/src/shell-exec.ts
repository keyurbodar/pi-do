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

interface ExecSession {
  bash: Bash;
  env: Record<string, string>;
  cwd: string;
  running: AbortController | null;
  killRequested: boolean;
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
    if (session === undefined) {
      session = { bash: freshBash(), env: {}, cwd: DEFAULT_CWD, running: null, killRequested: false };
      this.sessions.set(sid, session);
    }
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
        cwd: input.cwd ?? session.cwd,
        env: { ...session.env, ...input.env },
        signal: controller.signal,
      });
      if (timedOut || session.killRequested || controller.signal.aborted) {
        return aborted(session, timedOut);
      }
      if (result.env !== undefined) {
        session.env = { ...result.env };
        const pwd = result.env["PWD"];
        if (typeof pwd === "string" && pwd.startsWith("/")) session.cwd = pwd;
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
      return { stdout: "", stderr: truncate(`${message}\n`), exit: 1, timedOut: false, killed: false };
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
    const session = this.sessions.get(sid);
    if (session === undefined) {
      throw new Error(`no such exec session: ${sid}`);
    }
    if (session.running === null) return { killed: false };
    session.killRequested = true;
    session.running.abort(new Error("Execution killed"));
    return { killed: true };
  }

  async dispose(input: { sid: string }): Promise<{ disposed: true }> {
    const sid = input?.sid;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new Error("dispose needs a session id string");
    }
    const session = this.sessions.get(sid);
    if (session !== undefined) {
      session.running?.abort(new Error("Session disposed"));
      this.sessions.delete(sid);
    }
    return { disposed: true };
  }
}

function aborted(session: ExecSession, timedOut: boolean): ShellExecResult {
  const killed = session.killRequested;
  session.killRequested = false;
  return { stdout: "", stderr: "", exit: 124, timedOut: true, killed };
}

async function runOneOff(command: string, cwd?: string, env?: Record<string, string>): Promise<ShellExecResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Execution timed out"));
  }, EXEC_TIMEOUT_MS);
  try {
    const result = await freshBash().exec(command, {
      cwd: cwd ?? DEFAULT_CWD,
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
