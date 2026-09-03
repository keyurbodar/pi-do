import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  Context as PiContext,
  Message as PiMessage,
  Model as PiModel,
  SimpleStreamOptions,
  ThinkingLevel,
  Tool as PiTool,
  ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";
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
  apiKey?: string;
}

export interface SessionToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  output: string;
}

export interface SessionUsage {
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  costTotal: number;
  elapsedMs: number;
  tokensPerSec: number | null;
}

export interface SessionTurn {
  result: string;
  toolCalls: SessionToolCall[];
  via: "createAgentSession";
  model: string;
  usage: SessionUsage;
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
  thinking?: string | null;
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
// Model-called loop state. The stub path below owns no pi-ai import at
// runtime: keyless turns never reach completeSimple, so behavior there is
// byte-identical to the planStubTurn harness it replaces.
const MAX_MODEL_STEPS = 10;
// Suppressed under this the rate is nonsense (cached/instant responses yield
// absurd tok/s). Same 100ms floor as OMP calculateTokensPerSecond.
const MIN_TURN_MS = 100;

const SYSTEM_PROMPT =
  'You are a coding assistant inside a Cloudflare Worker workspace. File paths are workspace-relative ("" is the workspace root). Use the tools to inspect and change files, then answer with a short summary of what you did.';

// SessionModel is the pi-cf subset; the worker passes its full RuntimeModel
// here, so extras ride through instead of being retyped per provider.
function toPiModel(model: SessionModel): PiModel<Api> {
  const source = model as SessionModel & Partial<PiModel<Api>>;
  return {
    id: source.id,
    name: source.name ?? source.id,
    api: (source.api ?? "openai-completions") as Api,
    provider: source.provider ?? "stub",
    baseUrl: source.baseUrl ?? "",
    reasoning: source.reasoning ?? false,
    thinkingLevelMap: source.thinkingLevelMap,
    input: source.input ?? ["text"],
    cost: source.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: source.contextWindow ?? 0,
    maxTokens: source.maxTokens ?? 0,
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value !== null && typeof value === "object" && "error" in value && typeof value.error === "string") {
    const hint = "hint" in value && typeof value.hint === "string" ? ` (${value.hint})` : "";
    return `${value.error}${hint}`;
  }
  return String(value ?? "tool failed");
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
    const modelId = model.id;
    const apiKey = options.apiKey;
    const keyed = model.api !== "stub" && typeof apiKey === "string" && apiKey.length > 0;
    if (keyed) return runModelTurn(prompt, apiKey, signal, onUpdate, runOptions?.thinking ?? null);
    const readFn = tools.read;
    const bashFn = tools.bash;
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
      usage: { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null },
    };
  }

  // Keyed loop: send messages plus tool schemas, execute our tools, append
  // results, repeat until the model stops calling tools or the step cap
  // hits. Same SessionTurn shape, same onUpdate events, same abort signal.
  async function runModelTurn(
    prompt: string,
    apiKey: string,
    signal: AbortSignal | undefined,
    onUpdate: ((event: SessionToolEvent) => void) | undefined,
    thinking: string | null,
  ): Promise<SessionTurn> {
    const modelId = model.id;
    const piTools: PiTool[] = Object.values(tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const messages: PiMessage[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
    const request: SimpleStreamOptions = { signal };
    if (thinking !== null && thinking !== "" && thinking !== "off") request.reasoning = thinking as ThinkingLevel;
    request.apiKey = apiKey;
    const toolCalls: SessionToolCall[] = [];
    let n = 0;
    let result = "";
    const openedAt = Date.now();
    let inTokens = 0;
    let outTokens = 0;
    let cacheRead = 0;
    let costTotal = 0;
    for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
      signal?.throwIfAborted();
      await abortablePause(signal);
      const piContext: PiContext = { systemPrompt: SYSTEM_PROMPT, messages, tools: piTools };
      const answer = await completeSimple(toPiModel(model), piContext, request);
      inTokens += answer.usage.input + answer.usage.cacheWrite;
      outTokens += answer.usage.output;
      cacheRead += answer.usage.cacheRead;
      costTotal += answer.usage.cost.total;
      if (answer.stopReason === "error" || answer.stopReason === "aborted") {
        signal?.throwIfAborted();
        // {error, hint} shape so both callers stay hinted: /run returns it
        // as-is, the stream formats it below. Never carries key material —
        // pi-ai errors hold status text only.
        throw {
          error: (answer.errorMessage ?? "model turn failed").slice(0, 300),
          hint: "retry the prompt; repeated auth/billing errors mean the provider key or quota needs attention",
        };
      }
      result = assistantText(answer);
      const calls = answer.content.filter((block): block is PiToolCall => block.type === "toolCall");
      if (answer.stopReason !== "toolUse" || calls.length === 0) break;
      messages.push(answer);
      for (const call of calls) {
        signal?.throwIfAborted();
        n += 1;
        const id = call.id.length > 0 ? call.id : `session-${n}`;
        const args = call.arguments ?? {};
        onUpdate?.({ kind: "toolCall", id, tool: call.name, args });
        const toolFn = tools[call.name as keyof SessionTools];
        let output: string;
        let isError = false;
        if (toolFn === undefined) {
          output = `unknown tool: ${call.name} (available: ${Object.keys(tools).join(", ")})`;
          isError = true;
        } else {
          try {
            output = textOf(await toolFn.execute(id, args, signal, undefined, context));
          } catch (e) {
            output = errorText(e);
            isError = true;
          }
        }
        toolCalls.push({ id, tool: call.name, args, output });
        onUpdate?.({ kind: "toolResult", id, tool: call.name, args, output });
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: output }],
          isError,
          timestamp: Date.now(),
        });
      }
    }
    const elapsedMs = Date.now() - openedAt;
    const tokensPerSec = elapsedMs < MIN_TURN_MS || outTokens <= 0 ? null : (outTokens * 1000) / elapsedMs;
    return {
      result,
      toolCalls,
      via: "createAgentSession",
      model: modelId,
      usage: { inTokens, outTokens, cacheRead, costTotal, elapsedMs, tokensPerSec },
    };
  }

  return { run };
}
