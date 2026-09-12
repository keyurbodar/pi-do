// project-context.test.mjs — one behavior per test over the real loader:
// ancestor-walk order, per-directory precedence, size caps, and the
// SYSTEM.md / APPEND_SYSTEM.md replace/append semantics at the session cwd.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureWorkspaceSchema } from "../src/store/sql-util.ts";
import { loadProjectContextMessage } from "../src/agent/project-context.ts";

function makeSql(sid, cwd) {
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
  sql.exec("INSERT INTO sessions(sid, cwd) VALUES (?, ?)", sid, cwd);
  return sql;
}

function makeFiles(seed, ws = "w") {
  const map = new Map();
  for (const [path, text] of Object.entries(seed)) map.set(`${ws}\0${path}`, new TextEncoder().encode(text));
  return {
    get(w, path) { return map.get(`${w}\0${path}`); },
  };
}

function load(seed, cwd, sid = "s") {
  return loadProjectContextMessage({ sql: makeSql(sid, cwd), files: makeFiles(seed), ws: "w", sid });
}

test("context chain walks outermost to cwd so the nearest file lands last", () => {
  const msg = load({ "AGENTS.md": "root", "docs/AGENTS.md": "docs", "docs/deep/AGENTS.md": "deep" }, "docs/deep");
  const i = (p) => msg.text.indexOf(`(${p})`);
  assert.ok(i("AGENTS.md") !== -1 && i("docs/AGENTS.md") !== -1 && i("docs/deep/AGENTS.md") !== -1);
  assert.ok(i("AGENTS.md") < i("docs/AGENTS.md") && i("docs/AGENTS.md") < i("docs/deep/AGENTS.md"));
  assert.match(msg.text, /deep/);
});

test("per-directory precedence: AGENTS.override.md beats AGENTS.md beats CLAUDE.md", () => {
  const full = load({ "docs/AGENTS.override.md": "ovr", "docs/AGENTS.md": "agents", "docs/CLAUDE.md": "claude", "docs/CLAUDE.MD": "claude-upper" }, "docs");
  assert.equal((full.text.match(/Project context \(/g) ?? []).length, 1);
  assert.match(full.text, /ovr/);
  assert.doesNotMatch(full.text, /agents|claude/);
  const noOverride = load({ "docs/AGENTS.md": "agents", "docs/CLAUDE.md": "claude", "docs/CLAUDE.MD": "claude-upper" }, "docs");
  assert.match(noOverride.text, /agents/);
  assert.doesNotMatch(noOverride.text, /claude/);
  const casing = load({ "docs/CLAUDE.md": "lower", "docs/CLAUDE.MD": "upper" }, "docs");
  assert.match(casing.text, /lower/);
  assert.doesNotMatch(casing.text, /upper/);
});

test("missing files are silently skipped; no files anywhere yields null", () => {
  const partial = load({ "docs/CLAUDE.md": "only-claude" }, "docs/sub");
  assert.equal((partial.text.match(/Project context \(/g) ?? []).length, 1);
  assert.match(partial.text, /only-claude/);
  assert.equal(load({}, "docs"), null);
});

test("per-file cap truncates at 32 KiB and total cap stops the walk at 96 KiB", () => {
  const big = "x".repeat(40 * 1024);
  const capped = load({ "AGENTS.md": big }, "docs/deep");
  assert.equal(capped.text.length, `Project context (AGENTS.md):\n`.length + 32 * 1024);
  // Bodies are truncated to 32 KiB each, so the 96 KiB total is reached after
  // three dirs; the cwd-nearest fourth must never be read.
  const filler = "y".repeat(50 * 1024);
  const total = load({ "AGENTS.md": filler, "docs/AGENTS.md": filler, "docs/deep/AGENTS.md": filler, "docs/deep/deeper/AGENTS.md": "nearest" }, "docs/deep/deeper");
  assert.doesNotMatch(total.text, /nearest/);
  assert.ok(total.text.length < 96 * 1024 + 200);
});

test("SYSTEM.md at the cwd replaces the composed block; APPEND_SYSTEM.md appends", () => {
  const replaced = load({ "AGENTS.md": "root", "docs/AGENTS.md": "docs", "docs/SYSTEM.md": "custom system" }, "docs");
  assert.equal(replaced.text, "custom system");
  const appended = load({ "docs/AGENTS.md": "docs", "docs/APPEND_SYSTEM.md": "extra" }, "docs");
  assert.equal(appended.text, "Project context (docs/AGENTS.md):\ndocs\n\nextra");
  const both = load({ "docs/SYSTEM.md": "custom system", "docs/APPEND_SYSTEM.md": "extra" }, "docs");
  assert.equal(both.text, "custom system\n\nextra");
  const appendOnly = load({ "docs/APPEND_SYSTEM.md": "extra" }, "docs");
  assert.equal(appendOnly.text, "extra");
});

test("empty cwd binds the workspace root; .. segments and missing column are refused", () => {
  const rootSession = load({ "AGENTS.md": "root-file" }, "");
  assert.match(rootSession.text, /root-file/);
  assert.equal(load({}, ""), null);
  const escape = load({ "AGENTS.md": "escape" }, "docs/..");
  assert.equal(escape, null);
});
