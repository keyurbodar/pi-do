// harness.ts — one headless turn: pi read plus bash tools against the env.
//
// Tool shape follows pi's AgentHarnessTool (execute(id, params, signal,
// onUpdate, context) from harness/types.ts) and the read/bash schemas in
// harness/tools plus coding-agent tools/index.ts, minus node-isms: reads go
// through ComputerExecutionEnv, exec through the SHELL_WORKER binding, no
// fs/process imports. Imports from pi-agent-core are type-only, so the
// workerd bundle carries none of its runtime.
import type {
  AgentHarnessTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { ComputerExecutionEnv } from "../../packages/pi-cf/src/env";
import { planStubTurn } from "./stub-model";

export interface HarnessContext {
  env: ComputerExecutionEnv;
}

export interface HarnessToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  output: string;
}

export interface HarnessTurn {
  result: string;
  toolCalls: HarnessToolCall[];
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

export const readTool: AgentHarnessTool<HarnessContext, any, { bytes: number }> = {
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

export const bashTool: AgentHarnessTool<HarnessContext, any, { exit: number }> = {
  name: "bash",
  label: "Bash",
  description: "Run a shell command in the workspace shell. Output is captured text.",
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

const tools: Record<string, AgentHarnessTool<HarnessContext, any, any>> = {
  read: readTool,
  bash: bashTool,
};

export async function runHeadlessTurn(
  prompt: string,
  env: ComputerExecutionEnv,
): Promise<HarnessTurn> {
  const context: HarnessContext = { env };
  const toolCalls: HarnessToolCall[] = [];
  const outputs: string[] = [];
  let n = 0;
  for (const step of planStubTurn(prompt)) {
    n += 1;
    const id = `stub-${n}`;
    if (step.kind === "read") {
      const result = await tools.read.execute(
        id,
        { path: step.path },
        undefined,
        undefined,
        context,
      );
      const output = textOf(result);
      toolCalls.push({ id, tool: "read", args: { path: step.path }, output });
      outputs.push(output);
    } else {
      const result = await tools.bash.execute(
        id,
        { command: step.command },
        undefined,
        undefined,
        context,
      );
      const output = textOf(result);
      toolCalls.push({ id, tool: "bash", args: { command: step.command }, output });
      outputs.push(output);
    }
  }
  return { result: outputs.join("\n"), toolCalls };
}
