// inbox.test.mjs — proves the durable-inbox store over the real modules
// (DatabaseSync, no mocks): request-id dedupe, claim + reclaim windows,
// delivered marking with outcome cursors, thread listing, and the wake
// prompt shape.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";

const { ensureWorkspaceSchema } = await import("pi-cf/store/sql-util");
const inbox = await import("pi-cf/store/inbox");
const engine = await import("../src/inbox.ts");

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
    transactionSync(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        fn();
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      db.exec("COMMIT");
    },
  };
  ensureWorkspaceSchema(sql);
  return sql;
}

const NOW = 1_000_000;
const RECLAIM = 120_000;

test("insert dedupes on request id and validates the body", () => {
  const sql = makeSql();
  const first = inbox.insertInbox(sql, "w", "a", "b", { body: "hello", requestId: "r1" });
  assert.ok(first.ok);
  const retry = inbox.insertInbox(sql, "w", "a", "b", { body: "hello", requestId: "r1" });
  assert.ok(retry.ok && retry.row.id === first.row.id);
  const otherSender = inbox.insertInbox(sql, "w", "c", "b", { body: "hello", requestId: "r1" });
  assert.ok(otherSender.ok && otherSender.row.id !== first.row.id);
  const noBody = inbox.insertInbox(sql, "w", "a", "b", { body: "" });
  assert.ok(!noBody.ok && typeof noBody.hint === "string");
});

test("undelivered rows claim once and reclaim after the window", () => {
  const sql = makeSql();
  inbox.insertInbox(sql, "w", "a", "b", { body: "m1" });
  const claimed = inbox.claimInbox(sql, "w", "b", NOW, RECLAIM);
  assert.equal(claimed.length, 1);
  assert.equal(inbox.claimInbox(sql, "w", "b", NOW + 1000, RECLAIM).length, 0);
  assert.equal(inbox.claimInbox(sql, "w", "b", NOW + RECLAIM + 1, RECLAIM).length, 1);
});

test("markDelivered removes rows from the wake path and records the outcome cursor", () => {
  const sql = makeSql();
  const ins = inbox.insertInbox(sql, "w", "a", "b", { body: "m1" });
  inbox.claimInbox(sql, "w", "b", NOW, RECLAIM);
  inbox.markDelivered(sql, "w", [ins.row.id], 42);
  assert.equal(inbox.listUndelivered(sql, "w", "b", NOW + 1000, RECLAIM).length, 0);
  const row = inbox.getInbox(sql, "w", ins.row.id);
  assert.equal(row.outcomeCursor, 42);
  assert.ok(row.deliveredAt !== null);
});

test("thread listing groups rows and listInbox covers both directions", () => {
  const sql = makeSql();
  inbox.insertInbox(sql, "w", "a", "b", { body: "one", thread: "t1" });
  inbox.insertInbox(sql, "w", "b", "a", { body: "two", thread: "t1" });
  inbox.insertInbox(sql, "w", "a", "b", { body: "unthreaded" });
  assert.equal(inbox.listThread(sql, "w", "t1").length, 2);
  const both = inbox.listInbox(sql, "w", "a");
  assert.equal(both.length, 3);
});

test("deliverDueInbox claims per recipient and rearms while rows remain", async () => {
  const sql = makeSql();
  const { ensureAlarmMuxSchema, dueJobs } = await import("../src/alarm-mux.ts");
  ensureAlarmMuxSchema(sql);
  inbox.insertInbox(sql, "w", "a", "b", { body: "m1" });
  inbox.insertInbox(sql, "w", "a", "c", { body: "m2" });
  const got = [];
  await engine.deliverDueInbox(sql, NOW, async (ws, sid, rows) => {
    got.push({ sid, rows });
    if (sid === "b") inbox.markDelivered(sql, "w", rows.map((r) => r.id), 7);
  });
  assert.equal(got.length, 2);
  assert.deepEqual(got.find((g) => g.sid === "b").rows.map((r) => r.body), ["m1"]);
  assert.deepEqual(dueJobs(sql, Date.now() + engine.INBOX_REARM_MS * 2), ["inbox"]);
});

test("inboxPrompt carries the sentinel plus sender, thread, and body", () => {
  const sql = makeSql();
  inbox.insertInbox(sql, "w", "a", "b", { body: "do the thing", thread: "offsite" });
  const rows = inbox.listUndelivered(sql, "w", "b", NOW + 1000, RECLAIM);
  const prompt = engine.inboxPrompt(rows);
  assert.match(prompt, /<inbox-changed count="1"\/>/);
  assert.match(prompt, /message from a in thread offsite: do the thing/);
});
