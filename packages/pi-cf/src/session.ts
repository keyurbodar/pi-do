import {
  ComputerExecutionEnv,
  type FileStoreLike,
  type ShellLike,
} from "./env.ts";
import { bashTool, editTool, listTool, readTool, removeTool, textOf, writeTool, type ToolContext } from "./tools.ts";
import { planStubTurn } from "./stub-plan.ts";

export const sessionTools = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  list: listTool,
  remove: removeTool,
  bash: bashTool,
};

export type SessionTools = typeof sessionTools;

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
  tools?: Partial<SessionTools>;
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


export interface SessionToolEvent {
  kind: "toolCall" | "toolResult";
  id: string;
  tool: string;
  args: Record<string, unknown>;
  output?: string;
}

export interface SessionRunOptions {
  signal?: AbortSignal;
  onUpdate?: (event: SessionToolEvent) => void;
}

// Abortable pause between steps. Only the streaming path passes a signal,
// so the one-shot /run path keeps its timing; the pause opens an abort
// window so a live {abort} frame lands mid-turn instead of after {done}.
function abortablePause(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, 250);
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export function createAgentSession(options: CreateAgentSessionOptions): {
  run(prompt: string, runOptions?: SessionRunOptions): Promise<SessionTurn>;
} {
  const { files, ws, shell, model } = options;
  const tools: SessionTools = { ...sessionTools, ...options.tools };
  const env = new ComputerExecutionEnv(files, ws, shell);
  const context: ToolContext = { env };

  async function run(prompt: string, runOptions?: SessionRunOptions): Promise<SessionTurn> {
    const signal = runOptions?.signal;
    const onUpdate = runOptions?.onUpdate;
    const readFn = tools.read;
    const bashFn = tools.bash;
    const modelId = model.id;
    const toolCalls: SessionToolCall[] = [];
    const outputs: string[] = [];
    let n = 0;
    for (const step of planStubTurn(prompt)) {
      signal?.throwIfAborted();
      await abortablePause(signal);
      n += 1;
      const id = `session-${n}`;
      const tool = step.kind;
      const args = step.kind === "read" ? { path: step.path } : { command: step.command };
      onUpdate?.({ kind: "toolCall", id, tool, args });
      const toolFn = step.kind === "read" ? readFn : bashFn;
      const result = await toolFn.execute(id, args, signal, undefined, context);
      const output = textOf(result);
      toolCalls.push({ id, tool, args, output });
      outputs.push(output);
      onUpdate?.({ kind: "toolResult", id, tool, args, output });
    }
    return {
      result: outputs.join("\n"),
      toolCalls,
      via: "createAgentSession",
      model: modelId,
    };
  }

  return { run };
}
