import {
  ComputerExecutionEnv,
  type FileStoreLike,
  type ShellLike,
} from "./env";
import { bashTool, readTool, textOf, type ToolContext } from "./tools";
import { planStubTurn } from "./stub-plan";

export const sessionTools = {
  read: readTool,
  bash: bashTool,
};

export interface SessionModel {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
}

export interface CreateAgentSessionOptions {
  files: FileStoreLike;
  ws: string;
  shell: ShellLike;
  model: SessionModel;
}

export interface SessionToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  output: string;
}

export interface SessionTurn {
  result: string;
  toolCalls: SessionToolCall[];
  via: "createAgentSession";
  model: string;
}

export function createAgentSession(options: CreateAgentSessionOptions): {
  run(prompt: string): Promise<SessionTurn>;
} {
  const { files, ws, shell, model } = options;
  const env = new ComputerExecutionEnv(files, ws, shell);
  const context: ToolContext = { env };

  async function run(prompt: string): Promise<SessionTurn> {
    const toolCalls: SessionToolCall[] = [];
    const outputs: string[] = [];
    let n = 0;
    for (const step of planStubTurn(prompt)) {
      n += 1;
      const id = `session-${n}`;
      if (step.kind === "read") {
        const result = await sessionTools.read.execute(
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
        const result = await sessionTools.bash.execute(
          id,
          { command: step.command },
          undefined,
          undefined,
          context,
        );
        const output = textOf(result);
        toolCalls.push({
          id,
          tool: "bash",
          args: { command: step.command },
          output,
        });
        outputs.push(output);
      }
    }
    return {
      result: outputs.join("\n"),
      toolCalls,
      via: "createAgentSession",
      model: model.id,
    };
  }

  return { run };
}
