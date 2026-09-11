// framing.test.mjs — fast conformance suite for the worker turn protocol:
// budget parsing plus error shaping plus fence re-claim surfacing. Imports
// the side-effect-free protocol module and the fence CAS helper only, so
// plain node runs it without the worker runtime. The meta payload shape is
// proven via source read (routes/table.ts precedent): sessions.ts cannot
// load under plain node (extensionless sibling imports).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET_CAPS, isUnknownModel, parseBudgets, shaped } from "../src/protocol.ts";
import { BUDGET_CAPS as SINGLE_CAPS, parseBudgets as singleParseBudgets } from "pi-cf/agent/budgets";
import { enforceFence } from "pi-cf/store/fence";

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

test("protocol re-exports the single pi-cf budget validator", () => {
  assert.equal(parseBudgets, singleParseBudgets);
  assert.equal(BUDGET_CAPS, SINGLE_CAPS);
  assert.deepEqual({ ...BUDGET_CAPS }, { maxTurns: 200, maxToolCalls: 1000, maxDurationMs: 1800000, maxCost: 100 });
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

test("403 body carries the live fence for re-claim", () => {
  const res = enforceFence({ fence: "live-1", revision: 7 }, "stale-0", 7);
  assert.equal("status" in res && res.status, 403);
  if ("status" in res) {
    assert.equal(res.body.error, "fence mismatch");
    assert.equal(res.body.revision, 7);
    assert.equal(res.body.fence, "live-1");
  }
  const missing = enforceFence(null, "stale-0", 0);
  assert.equal("status" in missing && missing.status, 403);
  if ("status" in missing) {
    assert.equal(missing.body.revision, 0);
    assert.equal(missing.body.fence, null);
  }
});

test("409 body carries live fence plus revision for re-claim", () => {
  const res = enforceFence({ fence: "live-1", revision: 7 }, "live-1", 6);
  assert.equal("status" in res && res.status, 409);
  if ("status" in res) {
    assert.equal(res.body.error, "revision conflict");
    assert.equal(res.body.revision, 7);
    assert.equal(res.body.fence, "live-1");
  }
});

test("session meta payload carries the live fence", () => {
  const src = fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "src/routes/sessions.ts"), "utf8");
  const meta = src.slice(src.indexOf("const meta:"), src.indexOf("const snapshot:"));
  assert.ok(meta.includes("ctx.readFence(sid)"), "meta reads the live fence");
  assert.ok(meta.includes("fence: fenced?.fence ?? null"), "meta payload carries fence");
});
