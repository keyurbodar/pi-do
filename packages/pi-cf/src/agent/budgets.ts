// budgets.ts — the single budget validator: caps, wire parsing with typed
// errors, and run-limit resolution. Imported by pi-cf's session and the
// worker protocol; caps are defined here and nowhere else. Pure module:
// no runtime imports, safe for plain node --test on both sides.
import type { SessionRunBudgets } from "./session.ts";

export const BUDGET_CAPS = { maxTurns: 200, maxToolCalls: 1000, maxDurationMs: 1800000, maxCost: 100 } as const;

export const DEFAULT_RUN_BUDGETS = { maxTurns: 25, maxToolCalls: 100, maxDurationMs: 600000, maxCost: 5 };

export function parseBudgets(raw: unknown): { ok: true; budgets: SessionRunBudgets | undefined } | { ok: false; error: string; hint: string } {
  if (raw === undefined) return { ok: true, budgets: undefined };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "bad budgets", hint: 'retry with {"budgets": {"maxTurns": 25}}; numeric fields must be finite numbers >= 0, toolExecution "sequential" or "parallel"' };
  }
  const rec = raw as Record<string, unknown>;
  const budgets: SessionRunBudgets = {};
  for (const field of ["maxTurns", "maxToolCalls", "maxDurationMs", "maxCost"] as const) {
    const value = rec[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, error: `bad budgets.${field}`, hint: `set budgets.${field} to a finite number >= 0, capped at ${BUDGET_CAPS[field]}` };
    }
    budgets[field] = Math.min(value, BUDGET_CAPS[field]);
  }
  for (const field of ["maxRetries", "maxRetryDelayMs", "timeoutMs"] as const) {
    const value = rec[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, error: `bad budgets.${field}`, hint: `set budgets.${field} to a finite number >= 0` };
    }
    budgets[field] = value;
  }
  const toolExecution = rec["toolExecution"];
  if (toolExecution !== undefined) {
    if (toolExecution !== "sequential" && toolExecution !== "parallel") {
      return { ok: false, error: "bad budgets.toolExecution", hint: 'set budgets.toolExecution to "sequential" or "parallel"' };
    }
    budgets.toolExecution = toolExecution;
  }
  return { ok: true, budgets };
}

export interface ResolvedRunLimits {
  maxTurns: number; maxToolCalls: number; maxDurationMs: number; maxCost: number;
  maxRetries: number | undefined; maxRetryDelayMs: number | undefined; timeoutMs: number | undefined;
  toolExecution: "sequential" | "parallel";
}

export function resolveRunLimits(budgets: SessionRunBudgets | undefined): ResolvedRunLimits {
  const valid = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const validOpt = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    maxTurns: valid(budgets?.maxTurns, DEFAULT_RUN_BUDGETS.maxTurns),
    maxToolCalls: valid(budgets?.maxToolCalls, DEFAULT_RUN_BUDGETS.maxToolCalls),
    maxDurationMs: valid(budgets?.maxDurationMs, DEFAULT_RUN_BUDGETS.maxDurationMs),
    maxCost: valid(budgets?.maxCost, DEFAULT_RUN_BUDGETS.maxCost),
    maxRetries: validOpt(budgets?.maxRetries),
    maxRetryDelayMs: validOpt(budgets?.maxRetryDelayMs),
    timeoutMs: validOpt(budgets?.timeoutMs),
    toolExecution: budgets?.toolExecution === "sequential" ? ("sequential" as const) : ("parallel" as const),
  };
}
