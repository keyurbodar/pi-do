import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./tools.ts";

type BgParams = {
  action: "start" | "read" | "kill";
  command?: string;
  handle?: string;
  cwd?: string;
  env?: Record<string, string>;
};

const BG_POLL_INTERVAL_MS = 100;
const BG_READ_CAP_MS = 60_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const bgTool: AgentHarnessTool<ToolContext, any, any> = {
  name: "bg",
  label: "Bg",
  description:
    "Run a shell command as a background process: start launches detached and returns a handle, read polls the handle until done (up to 60s per call), kill stops it. Output capped at 1 MiB, cwd pinned to the workspace.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "read", "kill"] },
      command: { type: "string" },
      handle: { type: "string" },
      cwd: { type: "string" },
      env: { type: "object" },
    },
    required: ["action"],
  },
  async execute(id, params: BgParams, signal, _onUpdate, context) {
    void id;
    if (params.action === "start") {
      if (!params.command) {
        throw {
          error: "missing command",
          hint: 'retry bg with {action:start, command} e.g. {action:start, command:"sleep 30"}',
        };
      }
      const out = await context.env.bgStart({ command: params.command, cwd: params.cwd, env: params.env });
      if (signal?.aborted) {
        await context.env.bgKill({ handle: out.handle });
      }
      return {
        content: [{ type: "text", text: out.handle }],
        details: { handle: out.handle },
      };
    }
    if (params.action === "read") {
      if (!params.handle) {
        throw {
          error: "missing handle",
          hint: "retry bg with {action:read, handle} from a bg start result",
        };
      }
      const deadline = Date.now() + BG_READ_CAP_MS;
      let out = await context.env.bgRead({ handle: params.handle });
      while (!out.done && Date.now() < deadline) {
        if (signal?.aborted) break;
        await delay(BG_POLL_INTERVAL_MS, signal);
        out = await context.env.bgRead({ handle: params.handle });
      }
      if (!out.done && signal?.aborted) {
        await context.env.bgKill({ handle: params.handle });
        out = { ...out, done: true, killed: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        details: { done: out.done },
      };
    }
    if (params.action === "kill") {
      if (!params.handle) {
        throw {
          error: "missing handle",
          hint: "retry bg with {action:kill, handle} from a bg start result",
        };
      }
      const out = await context.env.bgKill({ handle: params.handle });
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        details: { killed: out.killed },
      };
    }
    throw {
      error: "missing action",
      hint: "retry bg with {action:start|read|kill}",
    };
  },
};
