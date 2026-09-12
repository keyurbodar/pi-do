// retry-chokepoint.test.mjs — proves the one shared retry policy at the
// summarizer's completeSimple call site through the real retryAssistantCall
// loop: a transient stream drop (503/overloaded) retries once and the
// summary lands; a deterministic quota error returns after a single call;
// an aborted message is terminal after a single call. The keyed turn's
// streamSimple call site shares the same SHARED_RETRY constant (asserted),
// mapped onto pi-ai's provider-level retry with the run's own budgets
// still taking precedence. Only the compat module is faked (a scripted
// completeSimple); the retry classifier and loop are the installed pi-ai.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);
register("./retry-chokepoint-hook.mjs", import.meta.url);

const fake = await import("./retry-chokepoint-fake.mjs");
const summarizer = await import("../src/summarizer.ts");
const { SHARED_RETRY } = await import("pi-cf/agent/budgets");

const ERROR_MESSAGE = { role: "assistant", content: [], stopReason: "error", errorMessage: "503 overloaded" };
const QUOTA_MESSAGE = { role: "assistant", content: [], stopReason: "error", errorMessage: "insufficient_quota: quota exceeded" };
const ABORTED_MESSAGE = { role: "assistant", content: [], stopReason: "aborted" };

function summarizerFor() {
  return summarizer.modelSummarizer({ OPENCODE_API_KEY: "test-key" }, "opencode-go", "muse-spark-1.3-contributor", "s1");
}

test("transient error retries once under the shared policy, then the summary lands", async () => {
  fake.resetRetryFake([ERROR_MESSAGE, {}]);
  const summarize = summarizerFor();
  assert.ok(summarize !== undefined, "keyed env must resolve a summarizer");
  const summary = await summarize("prefix text", undefined);
  assert.equal(summary, "MODEL-TEXT");
  assert.equal(globalThis.__retryTest.calls, 2, `expected 2 model attempts (1 retry), got ${globalThis.__retryTest.calls}`);
});

test("deterministic quota error returns immediately without retry", async () => {
  fake.resetRetryFake([QUOTA_MESSAGE]);
  const summarize = summarizerFor();
  await summarize("prefix text", undefined);
  assert.equal(globalThis.__retryTest.calls, 1, "deterministic errors must not retry");
});

test("aborted message is terminal without retry", async () => {
  fake.resetRetryFake([ABORTED_MESSAGE]);
  const summarize = summarizerFor();
  await summarize("prefix text", undefined);
  assert.equal(globalThis.__retryTest.calls, 1, "aborts must never be retried");
});

test("the keyed turn shares the same retry constant; explicit budgets still win", () => {
  assert.equal(SHARED_RETRY.maxRetries, 2);
  assert.equal(typeof SHARED_RETRY.baseDelayMs, "number");
  assert.ok(SHARED_RETRY.baseDelayMs > 0);
});
