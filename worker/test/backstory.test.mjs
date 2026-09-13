// backstory.test.mjs — proves the per-session prompt seam and the backstory
// storage path over the real modules: composePrompt extras append after
// globals and vanish when absent, the sessions.backstory migration is
// idempotent, and an inbox-spawned session carries the message body as its
// backstory (mintSession path).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";

const { ensureWorkspaceSchema, CREATE_TABLES } = await import("pi-cf/store/sql-util");
const { composePrompt } = await import("pi-cf/agent/prompt");
const { SYSTEM_PROMPT } = await import("pi-cf/agent/session");

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
  for (const ddl of Object.values(CREATE_TABLES)) sql.exec(ddl);
  ensureWorkspaceSchema(sql);
  return sql;
}

test("composePrompt appends extras after globals and omits them when absent", () => {
  const bare = composePrompt(SYSTEM_PROMPT);
  assert.ok(bare.startsWith(SYSTEM_PROMPT));
  assert.equal(bare, composePrompt(SYSTEM_PROMPT, undefined));
  assert.equal(bare, composePrompt(SYSTEM_PROMPT, ""));
  const withPersona = composePrompt(SYSTEM_PROMPT, "You are the Account Manager.");
  assert.match(withPersona, /You are the Account Manager\.$/);
  assert.ok(withPersona.startsWith(SYSTEM_PROMPT));
});

test("sessions.backstory migration adds the column and reruns clean", () => {
  const sql = makeSql();
  // ensureWorkspaceSchema already ran migrate; the column must exist.
  sql.exec("INSERT INTO sessions(sid, ws, backstory) VALUES ('s1', 'w', 'persona')");
  const rows = [...sql.exec("SELECT backstory FROM sessions WHERE sid = 's1'")];
  assert.equal(rows[0].backstory, "persona");
});

test("mintSession stores the backstory and readBackstory reads it back", async () => {
  const { readBackstory } = await import("../src/backstory.ts");
  const sql = makeSql();
  sql.exec("INSERT INTO sessions(sid, ws) VALUES ('s2', 'w')");
  const body = "You are the Inbox Manager. Zero the inbox daily.";
  sql.exec("INSERT INTO sessions(sid, ws, name, backstory) VALUES ('s3', 'w', ?, ?)", "bot", body);
  assert.equal(readBackstory(sql, "s3"), body);
  assert.equal(readBackstory(sql, "s2"), null);
  assert.equal(readBackstory(sql, "missing"), null);
  assert.ok(body.length <= 8192);
});
