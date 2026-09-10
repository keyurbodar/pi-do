import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Model as PiModel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { EntryRow } from "../store/entries.ts";
import { Agent, type AgentEvent, type AgentHarnessTool, type AgentMessage, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  ComputerExecutionEnv,
  type FileStoreLike,
  type ShellLike,
} from "../runtime/env.ts";
import { bashTool, editTool, listTool, readTool, removeTool, textOf, writeTool, type ToolContext } from "../tools/tools.ts";
import { pmTool, testTool } from "../tools/dev-tools.ts";
import { definitionTool, diagnosticsCompilerTool, referencesTool } from "../tools/ts-tools.ts";
import { bgTool } from "../tools/bg-tools.ts";
import { findTool, grepTool } from "../tools/search-tools.ts";
import { planStubTurn } from "./stub-plan.ts";
import { buildSessionContextFromEntries, capSessionContext, estimateTokens, type ContextMessage } from "./context.ts";
export const sessionTools = {
  read: readTool, write: writeTool, edit: editTool, list: listTool, remove: removeTool, bash: bashTool,
  find: findTool, grep: grepTool, diagnostics: diagnosticsCompilerTool,
  definition: definitionTool, references: referencesTool, test: testTool, pm: pmTool, bg: bgTool,
};

export type SessionTools = typeof sessionTools;

export interface SessionModel {
  id: string; name?: string; api?: string; provider?: string;
  baseUrl?: string; headers?: Record<string, string>; contextWindow?: number; maxTokens?: number;
}

export interface CreateAgentSessionOptions {
  files: FileStoreLike; ws: string; shell: ShellLike; model: SessionModel; tools?: Partial<SessionTools>;
  apiKey?: string; history?: { leaf: number; readEntries: (after: number, limit: number) => EntryRow[] };
  sessionId?: string; cacheRetention?: "short" | "long";
}

export interface SessionToolCall {
  id: string; tool: string; args: Record<string, unknown>; output: string;
}

export interface SessionUsage {
  inTokens: number; outTokens: number; cacheRead: number;
  costTotal: number; elapsedMs: number; tokensPerSec: number | null; retention?: "short" | "long";
  // Wave-1 proof staging: wall-time split of the turn. sqlMs covers history/
  // context storage reads, inferenceMs the model call, frameMs the sink/
  // socket-frame callbacks. Optional so older persisted rows still typecheck;
  // every turn shaped here always carries all three as integers >= 0.
  sqlMs?: number; inferenceMs?: number; frameMs?: number;
}

export interface SessionTurn {
  result: string; toolCalls: SessionToolCall[]; via: "createAgentSession";
  model: string; usage: SessionUsage; halt?: SessionHalt;
}

export type HaltReason = "turns" | "tool-calls" | "duration" | "cost";

export interface SessionHalt {
  reason: HaltReason;
}

export interface SessionRunBudgets {
  maxTurns?: number; maxToolCalls?: number; maxDurationMs?: number; maxCost?: number;
  maxRetries?: number; maxRetryDelayMs?: number; timeoutMs?: number;
  toolExecution?: "sequential" | "parallel";
}

export type SessionToolEvent =
  | { kind: "toolCall"; id: string; tool: string; args: Record<string, unknown>; output?: string }
  | { kind: "toolResult"; id: string; tool: string; args: Record<string, unknown>; output?: string }
  | { kind: "toolUpdate"; id: string; tool: string; args: Record<string, unknown>; text: string }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string };

export interface SessionRunOptions {
  signal?: AbortSignal; onUpdate?: (event: SessionToolEvent) => void;
  thinking?: string | null; budgets?: SessionRunBudgets;
  onAgent?: (agent: Agent) => void;
}

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
const MIN_TURN_MS = 100;

const DEFAULT_RUN_BUDGETS = { maxTurns: 25, maxToolCalls: 100, maxDurationMs: 600000, maxCost: 5 };
const SYSTEM_PROMPT =
  'You are a coding assistant inside a Cloudflare Worker workspace. File paths are workspace-relative ("" is the workspace root). Use the tools to inspect and change files, then answer with a short summary of what you did.';

const STREAM_IDLE_TIMEOUT_MS = 300_000;
const HARD_ABORT_GRACE_MS = 10_000;
const TOOL_UPDATE_THROTTLE_MS = 1000;

function createThinkSplitter(
  onText: (delta: string) => void,
  onThinking: (delta: string) => void,
): { reset: () => void; push: (delta: string) => void } {
  let inThink = false;
  return {
    reset: () => { inThink = false; },
    push: (delta: string) => {
      let rest = delta;
      for (;;) {
        const open = rest.indexOf("<think>");
        const close = rest.indexOf("</think>");
        if (!inThink && open === -1 && close === -1) {
          if (rest.length > 0) onText(rest);
          return;
        }
        if (!inThink && close !== -1 && (open === -1 || close < open)) {
          rest = rest.slice(0, close) + rest.slice(close + "</think>".length);
          continue;
        }
        if (!inThink) {
          if (open > 0) onText(rest.slice(0, open));
          rest = rest.slice(open + "<think>".length);
          inThink = true;
          continue;
        }
        if (close === -1) {
          if (rest.length > 0) onThinking(rest);
          return;
        }
        if (close > 0) onThinking(rest.slice(0, close));
        rest = rest.slice(close + "</think>".length);
        inThink = false;
      }
    },
  };
}

function resultText(result: { content?: Array<{ type?: unknown; text?: unknown }> } | null | undefined): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "error" in error && typeof error.error === "string") {
    const hint = "hint" in error && typeof error.hint === "string" ? ` (${error.hint})` : "";
    return `${error.error}${hint}`;
  }
  return String(error ?? "tool failed");
}

export function createAgentSession(options: CreateAgentSessionOptions): {
  run(prompt: string, runOptions?: SessionRunOptions): Promise<SessionTurn>;
} {
  const { files, ws, shell, model } = options;
  const env = new ComputerExecutionEnv(files, ws, shell);
  const context: ToolContext = { env };

  async function run(prompt: string, runOptions?: SessionRunOptions): Promise<SessionTurn> {
    const signal = runOptions?.signal;
    const apiKey = options.apiKey;
    const retention = options.cacheRetention ?? "short";
    const tools: Record<string, AgentHarnessTool<ToolContext, any, any>> = { ...sessionTools, ...options.tools };
    // Timing split staging: sqlMs accumulates history storage reads below,
    // frameMs accumulates wall time inside the sink/socket-frame callbacks.
    // inferenceMs is measured around the model call inside each turn runner.
    const timing = { sqlMs: 0, frameMs: 0 };
    const innerUpdate = runOptions?.onUpdate;
    const onUpdate = innerUpdate === undefined ? undefined : (event: SessionToolEvent): void => {
      const t0 = Date.now();
      try {
        innerUpdate(event);
      } finally {
        timing.frameMs += Date.now() - t0;
      }
    };
    let history: ContextMessage[] = [];
    if (options.history !== undefined) {
      const tSql = Date.now();
      try {
        const entries: EntryRow[] = [];
        let after = 0;
        for (;;) {
          const batch = options.history.readEntries(after, 200);
          if (batch.length === 0) break;
          entries.push(...batch);
          const last = batch[batch.length - 1]?.cursor ?? after;
          if (last <= after) break;
          after = last;
        }
        history = buildSessionContextFromEntries(entries, options.history.leaf).messages;
      } catch {
        history = [];
      } finally {
        timing.sqlMs += Date.now() - tSql;
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
    if (keyed) return runModelTurn(prompt, apiKey, signal, onUpdate, runOptions?.thinking ?? null, tools, history, runOptions?.budgets, retention, runOptions?.onAgent, timing);
    return runStubTurn(prompt, signal, onUpdate, tools, retention, timing);
  }

  async function runStubTurn(
    prompt: string, signal: AbortSignal | undefined, onUpdate: ((event: SessionToolEvent) => void) | undefined,
    tools: Record<string, AgentHarnessTool<ToolContext, any, any>>, retention: "short" | "long",
    timing: { sqlMs: number; frameMs: number },
  ): Promise<SessionTurn> {
    const t0 = Date.now();
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
    const inferenceMs = Date.now() - t0;
    return {
      result: outputs.join("\n"), toolCalls, via: "createAgentSession", model: modelId,
      usage: { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null, retention, sqlMs: timing.sqlMs, inferenceMs, frameMs: timing.frameMs },
    };
  }

  async function runModelTurn(
    prompt: string, apiKey: string, signal: AbortSignal | undefined,
    onUpdate: ((event: SessionToolEvent) => void) | undefined, thinking: string | null,
    tools: Record<string, AgentHarnessTool<ToolContext, any, any>>, history: ContextMessage[],
    budgets: SessionRunBudgets | undefined, retention: "short" | "long",
    onAgent: ((agent: Agent) => void) | undefined,
    timing: { sqlMs: number; frameMs: number },
  ): Promise<SessionTurn> {
    const openedAt = Date.now();
    let inferenceMs = 0;
    const modelId = model.id;
    const source = model as SessionModel & Partial<PiModel<Api>>;
    const piModel: PiModel<Api> = {
      id: source.id, name: source.name ?? source.id, api: (source.api ?? "openai-completions") as Api,
      provider: source.provider ?? "stub", baseUrl: source.baseUrl ?? "", headers: source.headers,
      reasoning: source.reasoning ?? false, thinkingLevelMap: source.thinkingLevelMap, input: source.input ?? ["text"],
      cost: source.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: source.contextWindow ?? 0, maxTokens: source.maxTokens ?? 0,
    };
    const agentTools: Array<AgentTool<any>> = Object.values(tools).map((tool) => ({
      ...tool,
      execute: async (id: string, params: any, innerSignal: AbortSignal | undefined, onToolUpdate: ((partial: AgentToolResult<any>) => void) | undefined): Promise<AgentToolResult<any>> => {
        let lastUpdateAt = 0;
        const forwardUpdate = tool.name === "bash" && onToolUpdate !== undefined
          ? (partial: AgentToolResult<any>) => {
              const now = Date.now();
              if (now - lastUpdateAt < TOOL_UPDATE_THROTTLE_MS) return;
              lastUpdateAt = now;
              onToolUpdate(partial);
            }
          : undefined;
        try {
          return await tool.execute(id, params, innerSignal, forwardUpdate, context);
        } catch (error) {
          if (innerSignal?.aborted === true) throw error;
          throw new Error(failureText(error));
        }
      },
    }));
    const messages: AgentMessage[] = [];
    for (const item of history) {
      if (item.role === "assistant") {
        messages.push({
          role: "assistant", content: [{ type: "text", text: item.text }], api: piModel.api, provider: piModel.provider, model: piModel.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now(),
        });
      } else if (item.role === "compactionSummary") {
        messages.push({ role: "user", content: `Session summary:\n${item.text}`, timestamp: Date.now() });
      } else {
        messages.push({ role: "user", content: item.text, timestamp: Date.now() });
      }
    }
    const toolCalls: SessionToolCall[] = [];
    const pending = new Map<string, { id: string; args: Record<string, unknown> }>();
    let pendingTools = 0;
    let n = 0;
    let turns = 0;
    let inTokens = 0;
    let outTokens = 0;
    let cacheRead = 0;
    let costTotal = 0;
    let halted: HaltReason | undefined;
    const turnTexts: string[] = [];
    const failures: Array<{ errorMessage?: string }> = [];
    const finish = (halt: HaltReason | undefined): SessionTurn => {
      const elapsedMs = Date.now() - openedAt;
      const tokensPerSec = elapsedMs < MIN_TURN_MS || outTokens <= 0 ? null : (outTokens * 1000) / elapsedMs;
      const split = { sqlMs: timing.sqlMs, inferenceMs, frameMs: timing.frameMs };
      const usage = halt === undefined
        ? { inTokens, outTokens, cacheRead, costTotal, elapsedMs, tokensPerSec, retention, ...split }
        : { inTokens, outTokens, cacheRead, costTotal, elapsedMs, tokensPerSec, ...split };
      const result = turnTexts.join("\n\n");
      return halt === undefined
        ? { result, toolCalls, via: "createAgentSession", model: modelId, usage }
        : { result, toolCalls, via: "createAgentSession", model: modelId, usage, halt: { reason: halt } };
    };
    const valid = (value: number | undefined, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    const validOpt = (value: number | undefined): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const limits = {
      maxTurns: valid(budgets?.maxTurns, DEFAULT_RUN_BUDGETS.maxTurns),
      maxToolCalls: valid(budgets?.maxToolCalls, DEFAULT_RUN_BUDGETS.maxToolCalls),
      maxDurationMs: valid(budgets?.maxDurationMs, DEFAULT_RUN_BUDGETS.maxDurationMs),
      maxCost: valid(budgets?.maxCost, DEFAULT_RUN_BUDGETS.maxCost),
      maxRetries: validOpt(budgets?.maxRetries),
      maxRetryDelayMs: validOpt(budgets?.maxRetryDelayMs),
      timeoutMs: validOpt(budgets?.timeoutMs),
      toolExecution: budgets?.toolExecution === "sequential" ? ("sequential" as const) : ("parallel" as const),
    };
    if (limits.maxTurns <= 0) return finish("turns");
    if (limits.maxToolCalls <= 0) return finish("tool-calls");
    if (limits.maxDurationMs <= 0) return finish("duration");
    if (limits.maxCost <= 0) return finish("cost");
    const think = createThinkSplitter(
      (delta) => onUpdate?.({ kind: "text", delta }),
      (delta) => onUpdate?.({ kind: "thinking", delta }),
    );
    const takeId = (raw: string): string => {
      if (raw.length > 0) return raw;
      n += 1;
      return `session-${n}`;
    };
    const streamFn: StreamFn = (target, ctx, options) =>
      streamSimple(target, ctx, {
        ...options,
        apiKey: options?.apiKey ?? apiKey,
        cacheRetention: retention,
        ...(limits.maxRetries !== undefined ? { maxRetries: limits.maxRetries } : null),
        ...(limits.timeoutMs !== undefined ? { timeoutMs: limits.timeoutMs } : null),
      });
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT, model: piModel,
        messages, tools: agentTools,
        thinkingLevel: (thinking ?? "off") as ThinkingLevel,
      },
      streamFn,
      sessionId: options.sessionId !== undefined && options.sessionId.length > 0 ? options.sessionId : undefined,
      toolExecution: limits.toolExecution,
      maxRetryDelayMs: limits.maxRetryDelayMs,
      shouldStopAfterTurn: () => {
        if (turns >= limits.maxTurns) halted = "turns";
        else if (toolCalls.length >= limits.maxToolCalls) halted = "tool-calls";
        else if (Date.now() - openedAt >= limits.maxDurationMs) halted = "duration";
        else if (costTotal >= limits.maxCost) halted = "cost";
        return halted !== undefined;
      },
    });
    onAgent?.(agent);
    let settled = false;
    let stalled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHardDeadline: ((reason: unknown) => void) | undefined;
    const hardDeadline = new Promise<never>((_resolve, reject) => {
      rejectHardDeadline = reject;
    });
    const onIdle = (): void => {
      if (!settled && pendingTools === 0) {
        stalled = true;
        agent.abort();
      } else pokeIdle();
    };
    const pokeIdle = (): void => {
      clearTimeout(idleTimer);
      if (!settled) idleTimer = setTimeout(onIdle, STREAM_IDLE_TIMEOUT_MS);
    };
    const off = agent.subscribe((event: AgentEvent) => {
      pokeIdle();
      if (event.type === "message_start") think.reset();
      else if (event.type === "message_update") {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") { if (inner.delta.length > 0) think.push(inner.delta); }
        else if (inner.type === "thinking_delta" && inner.delta.length > 0) onUpdate?.({ kind: "thinking", delta: inner.delta });
      } else if (event.type === "tool_execution_start") {
        const args = (event.args ?? {}) as Record<string, unknown>;
        const id = takeId(event.toolCallId);
        pending.set(event.toolCallId, { id, args });
        pendingTools += 1;
        onUpdate?.({ kind: "toolCall", id, tool: event.toolName, args });
      } else if (event.type === "tool_execution_update") {
        const prior = pending.get(event.toolCallId);
        onUpdate?.({
          kind: "toolUpdate", id: prior?.id ?? takeId(event.toolCallId), tool: event.toolName,
          args: (event.args ?? {}) as Record<string, unknown>, text: resultText(event.partialResult),
        });
      } else if (event.type === "tool_execution_end") {
        const prior = pending.get(event.toolCallId);
        pendingTools -= 1;
        const id = prior?.id ?? takeId(event.toolCallId);
        const args = prior?.args ?? {};
        const output = resultText(event.result);
        onUpdate?.({ kind: "toolResult", id, tool: event.toolName, args, output });
      } else if (event.type === "turn_end" && event.message.role === "assistant") {
        const message = event.message;
        if (message.stopReason === "error" || message.stopReason === "aborted") failures.push(message);
        else {
          turns += 1;
          inTokens += message.usage.input + message.usage.cacheWrite;
          outTokens += message.usage.output;
          cacheRead += message.usage.cacheRead;
          costTotal += message.usage.cost.total;
          const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          if (text.length > 0) turnTexts.push(text);
          for (const item of event.toolResults) {
            const prior = pending.get(item.toolCallId);
            toolCalls.push({ id: prior?.id ?? item.toolCallId, tool: item.toolName, args: prior?.args ?? {}, output: resultText(item) });
          }
        }
      }
    });
    signal?.throwIfAborted();
    const onAbort = (): void => { agent.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    pokeIdle();
    hardTimer = setTimeout(() => {
      if (settled) return;
      agent.abort();
      graceTimer = setTimeout(() => {
        if (settled) return;
        rejectHardDeadline?.({
          error: "turn exceeded maxDurationMs and did not settle after abort",
          hint: "retry with a smaller prompt or a larger budgets.maxDurationMs; the agent was force-aborted",
        });
      }, HARD_ABORT_GRACE_MS);
    }, limits.maxDurationMs);
    const tInfer = Date.now();
    try {
      await Promise.race([agent.prompt({ role: "user", content: prompt, timestamp: Date.now() }), hardDeadline]);
    } finally {
      inferenceMs += Date.now() - tInfer;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      off();
    }
    signal?.throwIfAborted();
    if (stalled) throw { error: "model stream stalled", hint: "the provider stopped sending data mid-turn; retry the prompt" };
    if (failures.length > 0) {
      const failure = failures[failures.length - 1];
      throw {
        error: (failure.errorMessage ?? "model turn failed").slice(0, 300),
        hint: "retry the prompt; repeated auth/billing errors mean the provider key or quota needs attention",
      };
    }
    return finish(halted);
  }

  return { run };
}
