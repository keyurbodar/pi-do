// framing.test.mjs — fast conformance suite for the worker turn protocol:
// budget parsing plus error shaping. Imports the side-effect-free protocol
// module only, so plain node runs it without the worker runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { isUnknownModel, parseBudgets, shaped } from "../src/protocol.ts";

test("parseBudgets leaves undefined alone and admits explicit zero", () => {
  assert.deepEqual(parseBudgets(undefined), { ok: true, budgets: undefined });
  assert.deepEqual(
    parseBudgets({ maxTurns: 0, maxToolCalls: 0, maxDurationMs: 0, maxCost: 0 }),
    { ok: true, budgets: { maxTurns: 0, maxToolCalls: 0, maxDurationMs: 0, maxCost: 0 } },
  );
});

test("parseBudgets rejects negatives and garbage with typed errors", () => {
  for (const raw of [null, [], "x", 42]) {
    const res = parseBudgets(raw);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "bad budgets");
  }
  for (const field of ["maxTurns", "maxToolCalls", "maxDurationMs", "maxCost", "maxRetries", "maxRetryDelayMs", "timeoutMs"]) {
    const res = parseBudgets({ [field]: -1 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, `bad budgets.${field}`);
  }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
    const res = parseBudgets({ maxTurns: bad });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "bad budgets.maxTurns");
  }
  assert.deepEqual(
    parseBudgets({ toolExecution: "sideways" }),
    { ok: false, error: "bad budgets.toolExecution", hint: 'set budgets.toolExecution to "sequential" or "parallel"' },
  );
});

test("shaper passes messages through, appends causes, and falls back otherwise", () => {
  assert.deepEqual(
    shaped({ error: "unknown model foo", hint: "pick another" }, "unknown model", "retry"),
    { error: "unknown model foo", hint: "pick another" },
  );
  assert.deepEqual(shaped({ error: "boom" }, "fallback", "hint"), { error: "boom", hint: "hint" });
  assert.equal(shaped({ error: "x".repeat(400), hint: "h" }, "f", "h").error.length, 300);
  assert.deepEqual(shaped(new Error("down", { cause: new Error("root") }), "f", "h"), { error: "down: root", hint: "h" });
  assert.deepEqual(shaped(new Error("plain"), "f", "h"), { error: "plain", hint: "h" });
  assert.deepEqual(shaped("wire-down", "f", "h"), { error: "wire-down", hint: "h" });
  assert.deepEqual(shaped(42, "f", "h"), { error: "f", hint: "h" });
});

test("only known unknown-model errors qualify for the 404 path", () => {
  assert.equal(isUnknownModel({ error: "unknown model foo/bar" }), true);
  assert.equal(isUnknownModel({ error: "unknown provider foo" }), false);
  assert.equal(isUnknownModel(new Error("unknown model x")), false);
  assert.equal(isUnknownModel(null), false);
});
