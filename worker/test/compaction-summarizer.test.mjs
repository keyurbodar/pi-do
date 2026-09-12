// compaction-summarizer.test.mjs — proves the 48a usage-based trigger and
// the 48b summarizer seam over the real modules (DatabaseSync stores, no
// mocks): the live estimate is exact at the last usage-bearing result plus
// chars/4 for the trailing entries, the mark resolves the session's model
// contextWindow, an injected summarizer owns body.summary and receives the
// prior compaction's summary on a second compaction, and a throwing or
// empty summarizer degrades to the deterministic summary without failing
// the compaction.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";

const { ensureEntriesSchema, appendEntry, listEntries } = await import("pi-cf/store/entries");
const { ensureChunksSchema } = await import("pi-cf/store/chunks");
const { ensureRunsSchema } = await import("pi-cf/store/runs");
const { ensureWorkspaceSchema } = await import("pi-cf/store/sql-util");
const compaction = await import("../src/compaction.ts");
const { listCatalogModels } = await import("../src/model-runtime.ts");

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
  ensureEntriesSchema(sql);
  ensureChunksSchema(sql);
  ensureRunsSchema(sql);
  compaction.ensureCompactionSchema(sql);
  return sql;
}

function mintSession(sql, sid, model) {
  sql.exec("INSERT INTO sessions(sid, ws, created_at, modelProvider, modelId) VALUES (?, 'ws-test', ?, ?, ?)", sid, new Date().toISOString(), model?.provider ?? null, model?.id ?? null);
}

function seedTurns(sql, sid, turns, usageTotal = 400) {
  for (let i = 0; i < turns; i++) {
    appendEntry(sql, sid, "prompt", { prompt: `turn ${i} prompt for the seam test` });
    appendEntry(sql, sid, "toolCall", { tool: "read", args: { path: "seed.txt" } });
    appendEntry(sql, sid, "toolResult", { tool: "read", output: "seeded body" });
    appendEntry(sql, sid, "result", { result: `turn ${i} done`, usage: { input: 10, output: 5, totalTokens: usageTotal } });
  }
}

function catalogModel() {
  const line = listCatalogModels().find((m) => typeof m.contextWindow === "number" && m.contextWindow > 0);
  assert.ok(line, "bundled catalog must hold a model with a contextWindow");
  return { provider: line.provider, id: line.id, window: line.contextWindow };
}

test("liveTokenEstimate is exact at the last usage result plus chars/4 trailing", () => {
  const entries = [];
  const mk = (type, body) => entries.push({ cursor: entries.length + 1, type, body: JSON.stringify(body) });
  mk("prompt", { prompt: "early" });
  mk("result", { result: "early done", usage: { totalTokens: 500 } });
  mk("result", { result: "exact point", usage: { input: 100, output: 50, totalTokens: 1200 } });
  mk("prompt", { prompt: "tail prompt" });
  mk("text", { text: "tail text" });
  const trailing = entries.slice(3).reduce((sum, e) => sum + Math.ceil(e.body.length / 4), 0);
  assert.equal(compaction.liveTokenEstimate(entries), 1200 + trailing);
  // usage.totalTokens = 0 does not anchor; a zero-usage chain falls back to chars/4
  const stub = [
    { cursor: 1, type: "prompt", body: JSON.stringify({ prompt: "a" }) },
    { cursor: 2, type: "result", body: JSON.stringify({ result: "r", usage: { totalTokens: 0 } }) },
  ];
  assert.equal(compaction.liveTokenEstimate(stub), stub.reduce((sum, e) => sum + Math.ceil(e.body.length / 4), 0));
});

test("maybeMarkForCompaction resolves the session's model contextWindow", () => {
  const model = catalogModel();
  const sql = makeSql();
  mintSession(sql, "s-keyed", model);
  mintSession(sql, "s-stub", null);
  // One small turn keeps the keyed session above the reserve, so no mark.
  seedTurns(sql, "s-keyed", 1);
  assert.equal(compaction.maybeMarkForCompaction(sql, "s-keyed"), false);
  // Stub window (1000) minus anything is below the 16384 reserve: always marks.
  assert.equal(compaction.maybeMarkForCompaction(sql, "s-stub"), true);
  // A keyed session whose last usage sits past window - reserve does mark.
  seedTurns(sql, "s-keyed", 1, model.window + 1);
  assert.equal(compaction.maybeMarkForCompaction(sql, "s-keyed"), true);
});

test("runCompaction with a summarizer stores the model summary; prior summary chains", async () => {
  const calls = [];
  const fake = async (prefixText, previousSummary) => {
    calls.push({ prefixText, previousSummary });
    return `MODEL-SUMMARY-${calls.length}`;
  };
  const sql = makeSql();
  mintSession(sql, "s1", null);
  seedTurns(sql, "s1", 9);
  const first = await compaction.runCompaction(sql, "s1", true, [], fake);
  assert.equal(first.compacted, true);
  assert.equal(first.summarySource, "model");
  const [firstCall] = calls;
  assert.equal(firstCall.previousSummary, undefined);
  assert.match(firstCall.prefixText, /^user: turn 0 prompt/);
  assert.match(firstCall.prefixText, /tool\(read\(seed\.txt\)\):/);
  assert.match(firstCall.prefixText, /assistant: turn \d+ done/);
  const entries1 = listEntries(sql, "s1", { after: 0, limit: 100 });
  const summary1 = entries1.find((e) => e.type === "compaction");
  assert.equal(JSON.parse(summary1.body).summary, "MODEL-SUMMARY-1");

  seedTurns(sql, "s1", 9);
  const second = await compaction.runCompaction(sql, "s1", true, [], fake);
  assert.equal(second.compacted, true);
  assert.equal(calls[1].previousSummary, "MODEL-SUMMARY-1");
  const entries2 = listEntries(sql, "s1", { after: 0, limit: 100 });
  const summary2 = entries2.filter((e) => e.type === "compaction").pop();
  assert.equal(JSON.parse(summary2.body).summary, "MODEL-SUMMARY-2");
});

test("a throwing or empty summarizer degrades to the deterministic summary", async () => {
  const sql = makeSql();
  mintSession(sql, "s2", null);
  seedTurns(sql, "s2", 9);
  const throwing = compaction.runCompaction(sql, "s2", true, [], async () => {
    throw new Error("no key");
  });
  const degraded = await throwing;
  assert.equal(degraded.compacted, true);
  assert.equal(degraded.summarySource, "degraded");
  const entries = listEntries(sql, "s2", { after: 0, limit: 100 });
  const body = JSON.parse(entries.find((e) => e.type === "compaction").body);
  assert.match(body.summary, /^Archived \d+ entries \(cursors 1\.\./);

  mintSession(sql, "s3", null);
  seedTurns(sql, "s3", 9);
  const empty = await compaction.runCompaction(sql, "s3", true, [], async () => "   ");
  assert.equal(empty.summarySource, "degraded");

  mintSession(sql, "s4", null);
  seedTurns(sql, "s4", 9);
  const plain = await compaction.runCompaction(sql, "s4", true, []);
  assert.equal(plain.summarySource, "deterministic");
});
