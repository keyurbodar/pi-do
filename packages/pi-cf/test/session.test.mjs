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
import { ComputerExecutionEnv } from "../src/runtime/env.ts";
import { bashTool, editTool, listTool, readTool, writeTool } from "../src/tools/tools.ts";
import { bgTool } from "../src/tools/bg-tools.ts";

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

function makeMemFiles(seed = {}, ws = "w") {
  const map = new Map();
  const key = (w, path) => `${w}\0${path}`;
  for (const [path, text] of Object.entries(seed)) map.set(key(ws, path), new TextEncoder().encode(text));
  return {
    map,
    put(ws, path, body) {
      const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
      map.set(key(ws, path), bytes);
      return bytes.byteLength;
    },
    get(ws, path) { return map.get(key(ws, path)); },
    list(ws, dir) {
      const out = [];
      for (const [k, bytes] of map) {
        const sep = k.indexOf("\0");
        if (k.slice(0, sep) !== ws) continue;
        const path = k.slice(sep + 1);
        if (!path.startsWith(dir)) continue;
        out.push({ path, bytes: bytes.byteLength });
      }
      out.sort((a, b) => (a.path < b.path ? -1 : 1));
      return out;
    },
    exists(ws, path) { return map.has(key(ws, path)); },
    remove(ws, path) { return map.delete(key(ws, path)); },
  };
}

function makeMockShell() {
  const execs = [];
  const bgStarts = [];
  return {
    execs,
    bgStarts,
    exec: async (input) => { execs.push(input); return { stdout: "out\n", stderr: "", exit: 0, timedOut: false }; },
    bgStart: async (input) => { bgStarts.push(input); return { handle: "h-1" }; },
    bgRead: async () => ({ done: true, stdout: "out\n", exit: 0 }),
    bgKill: async () => ({ killed: true }),
  };
}

function makeCwdEnv({ cwd = "", seed = {} } = {}) {
  const store = makeMemFiles(seed);
  const shell = makeMockShell();
  const env = new ComputerExecutionEnv(store, "w", shell);
  env.cwd = cwd;
  return { env, store, shell };
}

test("relative read and write resolve under the session cwd", async () => {
  const { env, store } = makeCwdEnv({ cwd: "sub", seed: { "sub/f.txt": "hello\n" } });
  const out = await readTool.execute("r1", { path: "f.txt" }, undefined, undefined, { env });
  assert.match(out.content[0].text, /hello/);
  await writeTool.execute("w1", { path: "g.txt", content: "hi" }, undefined, undefined, { env });
  assert.ok(store.map.has("w\0sub/g.txt"));
  assert.ok(!store.map.has("w\0g.txt"));
});

test("relative edit resolves under the session cwd", async () => {
  const { env, store } = makeCwdEnv({ cwd: "sub", seed: { "sub/e.txt": "aaa\n" } });
  await editTool.execute("e1", { path: "e.txt", edits: [{ oldText: "aaa", newText: "bbb" }] }, undefined, undefined, { env });
  assert.equal(new TextDecoder().decode(store.map.get("w\0sub/e.txt")), "bbb\n");
});

test("list defaults to the session cwd", async () => {
  const { env } = makeCwdEnv({ cwd: "sub", seed: { "sub/a.txt": "a", "root.txt": "r" } });
  for (const params of [{}, { path: "" }]) {
    const out = await listTool.execute("l1", params, undefined, undefined, { env });
    assert.match(out.content[0].text, /sub\/a\.txt/);
    assert.doesNotMatch(out.content[0].text, /root\.txt/);
    assert.equal(out.details.count, 1);
  }
});

test("absolute tool paths still fail closed under a session cwd", async () => {
  const { env } = makeCwdEnv({ cwd: "sub", seed: { "sub/f.txt": "hello\n" } });
  const readErr = await readTool.execute("r1", { path: "/f.txt" }, undefined, undefined, { env }).then(() => null, (e) => e);
  assert.equal(readErr?.error, "bad path");
  const writeErr = await writeTool.execute("w1", { path: "/g.txt", content: "hi" }, undefined, undefined, { env }).then(() => null, (e) => e);
  assert.equal(writeErr?.error, "bad path");
});

test("bash defaults to the session cwd", async () => {
  const { env, shell } = makeCwdEnv({ cwd: "sub" });
  await bashTool.execute("b1", { command: "pwd" }, undefined, undefined, { env });
  assert.equal(shell.execs[0].cwd, "sub");
});

test("bg start defaults to the session cwd; explicit cwd wins", async () => {
  const { env, shell } = makeCwdEnv({ cwd: "sub" });
  await bgTool.execute("g1", { action: "start", command: "sleep 30" }, undefined, undefined, { env });
  assert.equal(shell.bgStarts[0].cwd, "sub");
  await bgTool.execute("g2", { action: "start", command: "sleep 30", cwd: "other" }, undefined, undefined, { env });
  assert.equal(shell.bgStarts[1].cwd, "other");
});

test("empty session cwd keeps workspace-root behavior", async () => {
  const { env, shell } = makeCwdEnv({ seed: { "f.txt": "root\n" } });
  const out = await readTool.execute("r1", { path: "f.txt" }, undefined, undefined, { env });
  assert.match(out.content[0].text, /root/);
  await bashTool.execute("b1", { command: "pwd" }, undefined, undefined, { env });
  assert.equal(shell.execs[0].cwd, "");
});
test("createAgentSession binds the session cwd for turn tools", async () => {
  const store = makeMemFiles({ "sub/seed.txt": "cwd-probe\n" });
  const shell = makeMockShell();
  const session = createAgentSession({
    files: store,
    ws: "w",
    shell,
    model: { id: "t", provider: "stub" },
    cwd: "sub",
  });
  const turn = await session.run("hi");
  assert.equal(turn.toolCalls.length, 2);
  assert.match(turn.toolCalls[0].output, /cwd-probe/);
  assert.equal(shell.execs[0].cwd, "sub");
});
