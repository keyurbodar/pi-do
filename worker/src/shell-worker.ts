// ShellWorker — one-off shell outside the agent loop, via just-bash.
//
// Shape copies refs/computer's worker-shell/entrypoint.ts (Dynamic Worker
// dispatch pattern): a WorkerEntrypoint with an exec method, reached through
// getEntrypoint("ShellWorker"). Each exec builds its own Bash on a fresh
// in-memory FS and disposes it when the run settles; no state survives
// across calls. Kill arrives in PR12, so runtime is capped with a fixed
// timeout and timeouts report as timedOut for the route to map to
// { error, hint }.
import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash } from "just-bash";

export interface ShellExecInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exit: number;
  timedOut: boolean;
}

export const DEFAULT_CWD = "/workspace";
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const EXEC_TIMEOUT_MS = 10_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) : s;
}

export class ShellWorker<Env = unknown> extends WorkerEntrypoint<Env> {
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
    const cwd = input.cwd ?? DEFAULT_CWD;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Execution timed out"));
    }, EXEC_TIMEOUT_MS);
    try {
      const bash = new Bash({
        cwd,
        // The isolate is the boundary; the in-isolate box needs
        // node:module hooks workerd lacks, so opt out (same call
        // refs/computer's entrypoint makes).
        defenseInDepth: { enabled: false },
        executionLimits: { maxOutputSize: MAX_OUTPUT_BYTES },
      });
      const result = await bash.exec(command, {
        cwd,
        env: input.env,
        signal: controller.signal,
      });
      if (timedOut) {
        return { stdout: "", stderr: "", exit: 124, timedOut: true };
      }
      return {
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
        exit: result.exitCode,
        timedOut: false,
      };
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        return { stdout: "", stderr: "", exit: 124, timedOut: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: truncate(`${message}\n`), exit: 1, timedOut: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
