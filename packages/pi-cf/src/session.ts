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
import { findTool, grepTool } from "./search-tools.ts";
import { diagnosticsTool, pmTool, testTool } from "./dev-tools.ts";
import { planStubTurn } from "./stub-plan.ts";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { buildSessionContext, capSessionContext, estimateTokens, type ContextMessage, type EntryReader } from "./context.ts";

export const sessionTools = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  list: listTool,
  remove: removeTool,
  bash: bashTool,
  find: findTool,
  grep: grepTool,
  diagnostics: diagnosticsTool,
  test: testTool,
  pm: pmTool,
};

export type SessionTools = typeof sessionTools;

export interface SessionModel {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CreateAgentSessionOptions {
  files: FileStoreLike;
  ws: string;
  shell: ShellLike;
  model: SessionModel;
  tools?: Partial<SessionTools>;
  apiKey?: string;
  history?: { leaf: number; readEntry: EntryReader };
  sessionId?: string;
  cacheRetention?: "short" | "long";
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
  retention?: "short" | "long";
}

export interface SessionTurn {
  result: string;
  toolCalls: SessionToolCall[];
  via: "createAgentSession";
  model: string;
  usage: SessionUsage;
  halt?: SessionHalt;
}

export type HaltReason = "turns" | "tool-calls" | "duration" | "cost";

export interface SessionHalt {
  reason: HaltReason;
}

export interface SessionRunBudgets {
  maxTurns?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxCost?: number;
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
  budgets?: SessionRunBudgets;
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
const TOOL_BATCH_CONCURRENCY = 4;

const DEFAULT_RUN_BUDGETS = {
  maxTurns: MAX_MODEL_STEPS,
  maxToolCalls: 32,
  maxDurationMs: 120000,
  maxCost: 0.5,
};

type ResolvedRunBudgets = {
  maxTurns: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxCost: number;
};

function validBudget(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveRunBudgets(budgets: SessionRunBudgets | undefined): ResolvedRunBudgets {
  return {
    maxTurns: validBudget(budgets?.maxTurns, DEFAULT_RUN_BUDGETS.maxTurns),
    maxToolCalls: validBudget(budgets?.maxToolCalls, DEFAULT_RUN_BUDGETS.maxToolCalls),
    maxDurationMs: validBudget(budgets?.maxDurationMs, DEFAULT_RUN_BUDGETS.maxDurationMs),
    maxCost: validBudget(budgets?.maxCost, DEFAULT_RUN_BUDGETS.maxCost),
  };
}

type BatchSlot = {
  id: string;
  call: PiToolCall;
  args: Record<string, unknown>;
  output: string;
  isError: boolean;
  settled: boolean;
};

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
  const env = new ComputerExecutionEnv(files, ws, shell);
  const context: ToolContext = { env };

  async function run(prompt: string, runOptions?: SessionRunOptions): Promise<SessionTurn> {
    const signal = runOptions?.signal;
    const onUpdate = runOptions?.onUpdate;
    const apiKey = options.apiKey;
    const retention = options.cacheRetention ?? "short";
    const tools: Record<string, AgentHarnessTool<ToolContext, any, any>> = { ...sessionTools, ...options.tools };
    let history: ContextMessage[] = [];
    if (options.history !== undefined) {
      try {
        history = buildSessionContext(options.history.leaf, options.history.readEntry).messages;
      } catch {
        history = [];
      }
    }
    const contextWindow = options.model.contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      const maxOut = options.model.maxTokens;
      const reserve =
        (typeof maxOut === "number" && Number.isFinite(maxOut) && maxOut > 0 ? maxOut : 0) +
        estimateTokens(prompt) +
        estimateTokens(SYSTEM_PROMPT);
      const base = { messages: history, model: null, thinking: "off", toolNames: null, skipped: [], truncated: false, dropped: 0 };
      const budget = contextWindow - reserve;
      history =
        budget > 0
          ? capSessionContext(base, budget).messages
          : base.messages.filter((message) => message.role === "compactionSummary");
    }
    const keyed = model.api !== "stub" && typeof apiKey === "string" && apiKey.length > 0;
    if (keyed) return runModelTurn(prompt, apiKey, signal, onUpdate, runOptions?.thinking ?? null, tools, history, runOptions?.budgets, retention);
    return runStubTurn(prompt, signal, onUpdate, tools, retention);
  }

  async function runStubTurn(
    prompt: string,
    signal: AbortSignal | undefined,
    onUpdate: ((event: SessionToolEvent) => void) | undefined,
    tools: Record<string, AgentHarnessTool<ToolContext, any, any>>,
    retention: "short" | "long",
  ): Promise<SessionTurn> {
    const modelId = model.id;
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
      usage: { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null, retention },
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
    tools: Record<string, AgentHarnessTool<ToolContext, any, any>>,
    history: ContextMessage[],
    budgets: SessionRunBudgets | undefined,
    retention: "short" | "long",
  ): Promise<SessionTurn> {
    const modelId = model.id;
    const piModel = toPiModel(model);
    const piTools: PiTool[] = Object.values(tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const messages: PiMessage[] = [];
    for (const item of history) {
      if (item.role === "assistant") {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: item.text }],
          api: piModel.api,
          provider: piModel.provider,
          model: piModel.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        });
      } else if (item.role === "compactionSummary") {
        messages.push({ role: "user", content: `Session summary:\n${item.text}`, timestamp: Date.now() });
      } else {
        messages.push({ role: "user", content: item.text, timestamp: Date.now() });
      }
    }
    messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    const request: SimpleStreamOptions = { signal };
    const sessionId = options.sessionId;
    if (sessionId !== undefined && sessionId.length > 0) request.sessionId = sessionId;
    if (thinking !== null && thinking !== "" && thinking !== "off") request.reasoning = thinking as ThinkingLevel;
    request.apiKey = apiKey;
    request.cacheRetention = retention;
    const toolCalls: SessionToolCall[] = [];
    let n = 0;
    let result = "";
    const openedAt = Date.now();
    let inTokens = 0;
    let outTokens = 0;
    let cacheRead = 0;
    let costTotal = 0;
    const limits = resolveRunBudgets(budgets);
    for (let step = 0; ; step += 1) {
      signal?.throwIfAborted();
      await abortablePause(signal);
      let halt: SessionHalt | undefined = undefined;
      if (step >= limits.maxTurns) halt = { reason: "turns" };
      else if (toolCalls.length >= limits.maxToolCalls) halt = { reason: "tool-calls" };
      else if (Date.now() - openedAt >= limits.maxDurationMs) halt = { reason: "duration" };
      else if (costTotal >= limits.maxCost) halt = { reason: "cost" };
      if (halt !== undefined) {
        const haltElapsedMs = Date.now() - openedAt;
        const haltTokensPerSec = haltElapsedMs < MIN_TURN_MS || outTokens <= 0 ? null : (outTokens * 1000) / haltElapsedMs;
        return {
          result,
          toolCalls,
          via: "createAgentSession",
          model: modelId,
          usage: { inTokens, outTokens, cacheRead, costTotal, elapsedMs: haltElapsedMs, tokensPerSec: haltTokensPerSec },
          halt,
        };
      }
      const piContext: PiContext = { systemPrompt: SYSTEM_PROMPT, messages, tools: piTools };
      const answer = await completeSimple(piModel, piContext, request);
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
      const slots: BatchSlot[] = [];
      const thunks: Array<() => Promise<void>> = [];
      for (const call of calls) {
        signal?.throwIfAborted();
        n += 1;
        const id = call.id.length > 0 ? call.id : `session-${n}`;
        const args = call.arguments ?? {};
        onUpdate?.({ kind: "toolCall", id, tool: call.name, args });
        const toolFn = tools[call.name];
        if (toolFn === undefined) {
          const output = `unknown tool: ${call.name} (available: ${Object.keys(tools).join(", ")})`;
          slots.push({ id, call, args, output, isError: true, settled: true });
          onUpdate?.({ kind: "toolResult", id, tool: call.name, args, output });
        } else {
          const slot: BatchSlot = { id, call, args, output: "", isError: false, settled: false };
          slots.push(slot);
          const fn = toolFn;
          thunks.push(async () => {
            try {
              slot.output = textOf(await fn.execute(id, args, signal, undefined, context));
            } catch (e) {
              slot.output = errorText(e);
              slot.isError = true;
            }
            slot.settled = true;
            onUpdate?.({ kind: "toolResult", id, tool: call.name, args, output: slot.output });
          });
        }
      }
      if (thunks.length === 1) {
        signal?.throwIfAborted();
        await thunks[0]();
      } else if (thunks.length > 1 && calls.some((call) => call.name === "bash")) {
        for (const thunk of thunks) {
          signal?.throwIfAborted();
          await thunk();
        }
      } else if (thunks.length > 1) {
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < thunks.length) {
            const thunk = thunks[next];
            next += 1;
            signal?.throwIfAborted();
            await thunk();
          }
        };
        const width = Math.min(TOOL_BATCH_CONCURRENCY, thunks.length);
        const runners: Array<Promise<void>> = [];
        for (let w = 0; w < width; w += 1) runners.push(worker());
        await Promise.all(runners);
      }
      signal?.throwIfAborted();
      for (const slot of slots) {
        toolCalls.push({ id: slot.id, tool: slot.call.name, args: slot.args, output: slot.output });
        messages.push({
          role: "toolResult",
          toolCallId: slot.call.id,
          toolName: slot.call.name,
          content: [{ type: "text", text: slot.output }],
          isError: slot.isError,
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
      usage: { inTokens, outTokens, cacheRead, costTotal, elapsedMs, tokensPerSec, retention },
    };
  }

  return { run };
}
