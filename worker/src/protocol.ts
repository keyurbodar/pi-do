// protocol.ts — side-effect-free turn-protocol pure functions: budget parsing,
// error shaping, unknown-model detection. Split from stream-engine.ts so plain
// node --test can load them without the worker runtime; zero runtime imports.
import type { SessionRunBudgets } from "pi-cf/agent/session";

const BUDGET_CAPS = { maxTurns: 200, maxToolCalls: 1000, maxDurationMs: 1800000, maxCost: 100 } as const;

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

// Model fallback chain: an unknown-model 404 on the turn's preferred catalog
// entry cycles the other keyed models in catalog order, then the stub, so the
// turn still runs. Anything else (unknown provider, bad MODEL_ID, invalid
// models.json) is a genuine config error and rethrows to keep surfacing.
export function isUnknownModel(e: unknown): boolean {
  if (e === null || typeof e !== "object" || !("error" in e)) return false;
  const error = e.error;
  return typeof error === "string" && error.startsWith("unknown model");
}

export function shaped(e: unknown, fallbackError: string, fallbackHint: string): { error: string; hint: string } {
  const rec = e !== null && typeof e === "object" ? (e as { error?: unknown; hint?: unknown }) : null;
  if (typeof rec?.error === "string") return { error: rec.error.slice(0, 300), hint: typeof rec?.hint === "string" ? rec.hint : fallbackHint };
  if (e instanceof Error) return { error: e.cause === undefined ? e.message : `${e.message}: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`, hint: fallbackHint };
  return { error: typeof e === "string" ? e : fallbackError, hint: fallbackHint };
}
