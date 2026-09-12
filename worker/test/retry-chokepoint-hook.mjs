// retry-chokepoint-hook.mjs — resolve hook for retry-chokepoint.test.mjs:
// intercepts the @earendil-works/pi-ai/compat specifier with the scripted
// fake; the pi-ai root (retryAssistantCall and friends) stays real, so the
// test proves the summarizer's wiring through the actual retry loop.
export async function resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-ai/compat" && context.parentURL?.includes("src/summarizer.ts")) {
    return { url: new URL("./retry-chokepoint-fake.mjs", import.meta.url).href, shortCircuit: true };
  }
  // worker/node_modules resolves pi-cf to the main checkout; the branch's
  // SHARED_RETRY lives in the worktree copy, so pin this specifier to it.
  if (specifier === "pi-cf/agent/budgets") {
    return { url: new URL("../../packages/pi-cf/src/agent/budgets.ts", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
