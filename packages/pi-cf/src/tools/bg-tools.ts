import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./tools.ts";

type BgParams = {
  action: "start" | "read" | "kill";
  command?: string;
  handle?: string;
  cwd?: string;
};

export const bgTool: AgentHarnessTool<ToolContext, any, any> = {
  name: "bg",
  label: "Bg",
  description:
    "Run a shell command as a background process: start launches detached and returns a handle, read polls the handle until done, kill stops it. Output capped at 1 MiB, cwd pinned to the workspace.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "read", "kill"] },
      command: { type: "string" },
      handle: { type: "string" },
      cwd: { type: "string" },
    },
    required: ["action"],
  },
  async execute(id, params: BgParams, _signal, _onUpdate, context) {
    void id;
    if (params.action === "start") {
      if (!params.command) {
        throw {
          error: "missing command",
          hint: 'retry bg with {action:start, command} e.g. {action:start, command:"sleep 30"}',
        };
      }
      const out = await context.env.bgStart({ command: params.command, cwd: params.cwd });
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
      const out = await context.env.bgRead({ handle: params.handle });
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
