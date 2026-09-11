// protocol.ts — side-effect-free turn-protocol pure functions: budget parsing,
// error shaping, unknown-model detection. Split from stream-engine.ts so plain
// node --test can load them without the worker runtime. Budget validation lives
// in pi-cf's single validator and is re-exported here so worker import paths
// stay put; the budgets module itself has zero runtime imports.
export { BUDGET_CAPS, parseBudgets } from "pi-cf/agent/budgets";

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
