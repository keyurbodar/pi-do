// session.test.mjs — fast conformance suite for the pi-cf agent session:
// lineage, run budgets, prompt composition, entry projectors. Real
// DatabaseSync :memory: store where lineage is concerned; the budget tests
// run the real session without ever reaching inference.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureWorkspaceSchema } from "../src/store/sql-util.ts";
import { sessionLineage } from "../src/agent/context.ts";
import { composePrompt, registerPromptSection, registerPromptSnippet } from "../src/agent/prompt.ts";
import { projectEntry, registerProjector } from "../src/agent/projectors.ts";
import { BUDGET_CAPS, DEFAULT_RUN_BUDGETS, parseBudgets, resolveRunLimits } from "../src/agent/budgets.ts";
import { createAgentSession } from "../src/agent/session.ts";

function makeSql() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...bindings) {
      const text = String(query);
      const stmt = db.prepare(text);
      if (/^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(text)) return stmt.all(...bindings);
      stmt.run(...bindings);
      return [];
    },
  };
  ensureWorkspaceSchema(sql);
  return sql;
}

const files = {
  put: () => 0,
  get: () => undefined,
  list: () => [],
  exists: () => false,
  remove: () => false,
};
const shell = {
  exec: async () => ({ stdout: "", stderr: "", exit: 0, timedOut: false }),
};

function makeKeyedSession() {
  return createAgentSession({
    files,
    ws: "w",
    shell,
    model: { id: "t", api: "openai-completions", provider: "stub", baseUrl: "" },
    apiKey: "k",
  });
}

test("session lineage follows parentSessionId root-first", () => {
  const sql = makeSql();
  sql.exec("INSERT INTO sessions(sid, parentSessionId) VALUES (?, ?)", "gp", null);
  sql.exec("INSERT INTO sessions(sid, parentSessionId) VALUES (?, ?)", "p", "gp");
  sql.exec("INSERT INTO sessions(sid, parentSessionId) VALUES (?, ?)", "c", "p");
  assert.deepEqual(sessionLineage(sql, "c"), ["gp", "p", "c"]);
  assert.deepEqual(sessionLineage(sql, "gp"), ["gp"]);
});

test("explicit zero budgets stop at the matching gate", async () => {
  for (const [budgets, reason] of [
    [{ maxTurns: 0 }, "turns"],
    [{ maxToolCalls: 0 }, "tool-calls"],
    [{ maxDurationMs: 0 }, "duration"],
    [{ maxCost: 0 }, "cost"],
  ]) {
    const turn = await makeKeyedSession().run("hi", { budgets });
    assert.deepEqual(turn.halt, { reason });
    assert.deepEqual(turn.toolCalls, []);
  }
});

test("undefined budgets proceed to the agent instead of halting", async () => {
  let sawAgent = false;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    makeKeyedSession().run("hi", { signal: controller.signal, onAgent: () => { sawAgent = true; } }),
    (e) => e?.name === "AbortError",
  );
  assert.equal(sawAgent, true);
});

test("single budget validator admits zero, caps, and rejects garbage with typed errors", () => {
  assert.deepEqual(parseBudgets(undefined), { ok: true, budgets: undefined });
  assert.deepEqual(parseBudgets({ maxTurns: 0 }), { ok: true, budgets: { maxTurns: 0 } });
  assert.deepEqual(parseBudgets({ maxTurns: 500 }), { ok: true, budgets: { maxTurns: BUDGET_CAPS.maxTurns } });
  for (const raw of [null, [], "x", 42]) {
    const res = parseBudgets(raw);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "bad budgets");
  }
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
    const res = parseBudgets({ maxToolCalls: bad });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "bad budgets.maxToolCalls");
  }
});

test("run limits fall back to defaults on garbage but keep explicit zero", () => {
  assert.deepEqual(resolveRunLimits(undefined), {
    ...DEFAULT_RUN_BUDGETS, maxRetries: undefined, maxRetryDelayMs: undefined, timeoutMs: undefined, toolExecution: "parallel",
  });
  assert.equal(resolveRunLimits({ maxTurns: 0 }).maxTurns, 0);
  assert.equal(resolveRunLimits({ maxTurns: -1 }).maxTurns, DEFAULT_RUN_BUDGETS.maxTurns);
  assert.equal(resolveRunLimits({ maxTurns: Number.NaN }).maxTurns, DEFAULT_RUN_BUDGETS.maxTurns);
  assert.equal(resolveRunLimits({ toolExecution: "sequential" }).toolExecution, "sequential");
});

test("prompt compose orders base, sections, then snippets", () => {
  registerPromptSection("t-rules", "follow the rules");
  registerPromptSnippet("t-snip: be brief");
  const out = composePrompt("t-base task");
  const base = out.indexOf("t-base task");
  const section = out.indexOf("## t-rules\nfollow the rules");
  const snippet = out.indexOf("t-snip: be brief");
  assert.ok(base !== -1 && section !== -1 && snippet !== -1);
  assert.ok(base < section && section < snippet);
});

test("projector registry serves custom types and falls back for the rest", () => {
  registerProjector("t-widget", { field: "widget", role: "user" });
  assert.deepEqual(projectEntry("t-widget"), { field: "widget", role: "user" });
  assert.deepEqual(projectEntry("prompt"), { field: "prompt", role: "user" });
  assert.equal(projectEntry("t-no-such-type"), undefined);
});
