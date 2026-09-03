import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { ComputerExecutionEnv } from "./env";

export interface ToolContext {
  env: ComputerExecutionEnv;
}

export function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

export const readTool: AgentHarnessTool<ToolContext, any, { bytes: number }> = {
  name: "read",
  label: "Read",
  description: "Read a workspace file as UTF-8 text. Paths are workspace-relative.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async execute(id, params: { path: string }, _signal, _onUpdate, context) {
    const bytes = context.env.readFile(params.path);
    const text = new TextDecoder().decode(bytes);
    return {
      content: [{ type: "text", text }],
      details: { bytes: bytes.byteLength },
    };
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
  async execute(id, params: { command: string }, _signal, _onUpdate, context) {
    const out = await context.env.exec(params.command);
    const text = out.stderr ? `${out.stdout}\n${out.stderr}` : out.stdout;
    return {
      content: [{ type: "text", text }],
      details: { exit: out.exit },
    };
  },
};
