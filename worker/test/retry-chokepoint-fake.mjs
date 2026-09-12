// retry-chokepoint-fake.mjs — module-double for @earendil-works/pi-ai/compat
// in retry-chokepoint.test.mjs: completeSimple is scripted from
// globalThis.__retryTest.responses (an array of AssistantMessage-like
// objects; the last one repeats) and counts calls so the tests can prove
// how many model attempts the shared policy made.
function message(overrides) {
  return {
    role: "assistant", content: [], api: "openai-completions", provider: "opencode-go", model: "muse-spark-1.3-contributor",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
    ...overrides,
  };
}

export function resetRetryFake(responses) {
  globalThis.__retryTest = { calls: 0, responses };
}

export async function completeSimple(model, context, options) {
  const state = globalThis.__retryTest;
  state.calls += 1;
  const responses = state.responses;
  const next = state.calls <= responses.length ? responses[state.calls - 1] : responses[responses.length - 1];
  if (next.stopReason !== undefined) return next;
  return message({ content: [{ type: "text", text: "MODEL-TEXT" }] });
}
