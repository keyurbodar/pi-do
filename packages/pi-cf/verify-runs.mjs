// verify-runs.mjs — drives entries.ts against real SQLite in-memory.
// Proves crashed runs flip to interrupted on next open while clean runs
// never produce false interrupted entries. Exit nonzero on the first gap.
import {
  appendEntry,
  closeRun,
  ensureEntriesSchema,
  entryHead,
  listEntries,
  openRun,
  recordTurnWithOpen,
} from "./src/store/entries.ts";
import { DatabaseSync } from "node:sqlite";
import { ensureWorkspaceSchema } from "./src/store/sql-util.ts";

function fail(step, want, got) {
  console.error(`FAIL ${step}: want ${want} got ${got}`);
  process.exit(1);
}

function eq(step, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(step, b, a);
}

function createRealSql() {
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
    statusOf(runId) {
      for (const row of sql.exec("SELECT status FROM runs WHERE runId = ? LIMIT 1", runId)) return row.status;
      return undefined;
    },
    leafOf(sid) {
      for (const row of sql.exec("SELECT leaf FROM sessions WHERE sid = ? LIMIT 1", sid)) return row.leaf ?? 0;
      return 0;
    },
  };
  ensureWorkspaceSchema(sql);
  ensureEntriesSchema(sql);
  // Fixture sessions: production inserts these on session create; the script
  // drives entries directly, so the backend seeds the two fixture sessions.
  for (const sid of ["s1", "s2"]) sql.exec("INSERT OR IGNORE INTO sessions(sid) VALUES (?)", sid);
  return sql;
}

const sql = createRealSql();
ensureEntriesSchema(sql);

recordTurnWithOpen(
  sql,
  "s1",
  "r1",
  "read seed.txt",
  [{ id: "t1", tool: "read", args: { path: "seed.txt" }, output: "seeded" }],
  "done",
);
eq("r1-closed", sql.statusOf("r1"), "closed");
openRun(sql, "s1", "r2");
eq("r2-open", sql.statusOf("r2"), "open");
eq(
  "clean-no-interrupted",
  listEntries(sql, "s1").filter((e) => e.type === "interrupted"),
  [],
);
eq(
  "turn-order",
  listEntries(sql, "s1").map((e) => e.type),
  ["prompt", "toolCall", "toolResult", "result"],
);
eq(
  "turn-runId",
  listEntries(sql, "s1").map((e) => JSON.parse(e.body).runId),
  ["r1", "r1", "r1", "r1"],
);

openRun(sql, "s1", "r3");
eq("r2-interrupted", sql.statusOf("r2"), "interrupted");
eq("r3-open", sql.statusOf("r3"), "open");
const interrupted = listEntries(sql, "s1").filter((e) => e.type === "interrupted");
eq("interrupted-count", interrupted.length, 1);
eq("interrupted-body", JSON.parse(interrupted[0].body), { runId: "r2", interruptedBy: "r3" });

const cursors = listEntries(sql, "s1").map((e) => e.cursor);
eq(
  "cursors-ordered",
  cursors,
  cursors.slice().sort((a, b) => a - b),
);
eq("cursors-nogap", cursors.every((c, i) => c === i + 1), true);
eq(
  "after-filter",
  listEntries(sql, "s1", 2).map((e) => e.cursor),
  cursors.filter((c) => c > 2),
);

const c = appendEntry(sql, "s2", "prompt", "raw-string");
eq("raw-cursor", c, 6);
eq("raw-body", listEntries(sql, "s2"), [{ cursor: 6, type: "prompt", body: "raw-string", parent: 0 }]);

// Closing an unknown run is a no-op, never an interrupted entry.
closeRun(sql, "s1", "nope");
eq(
  "close-unknown-clean",
  listEntries(sql, "s1").filter((e) => e.type === "interrupted").length,
  1,
);

eq("head-s1", entryHead(sql, "s1"), { count: 5, head: 5 });
eq("head-empty", entryHead(sql, "nobody"), { count: 0, head: 0 });

const p1 = listEntries(sql, "s1", { after: 0, limit: 2 }).map((e) => e.cursor);
const p2 = listEntries(sql, "s1", { after: 2, limit: 2 }).map((e) => e.cursor);
const p3 = listEntries(sql, "s1", { after: 4, limit: 2 }).map((e) => e.cursor);
eq("pages", [...p1, ...p2, ...p3], listEntries(sql, "s1").map((e) => e.cursor));
eq("clamp", listEntries(sql, "s1", { after: 0, limit: 5000 }).length, 5);

// Negative cursors fail closed, never silently clamp to zero.
for (const bad of [
  () => listEntries(sql, "s1", -1),
  () => listEntries(sql, "s1", { after: 0, limit: -1 }),
]) {
  let threw = false;
  try {
    bad();
  } catch {
    threw = true;
  }
  eq("fail-closed", threw, true);
}

// Interrupted path: an unclosed run stays open, so meta's openRun is truthful.
openRun(sql, "s1", "r4");
eq("r4-open", sql.statusOf("r4"), "open");
eq("head-interrupted", entryHead(sql, "s1"), { count: 6, head: 7 });
eq(
  "interrupted-points-forward",
  JSON.parse(listEntries(sql, "s1").at(-1).body),
  { runId: "r3", interruptedBy: "r4" },
);

// Parent links chain per session: first entry roots at 0, every later entry
// points at the previous cursor, even across the global id gap (s2 owns 6).
for (const sid of ["s1", "s2"]) {
  const rows = listEntries(sql, sid);
  eq(
    `parent-chain-${sid}`,
    rows.map((e) => e.parent),
    rows.map((e, i) => (i === 0 ? 0 : rows[i - 1].cursor)),
  );
}
eq("leaf-s1", sql.leafOf("s1"), 7);
eq("leaf-s2", sql.leafOf("s2"), 6);
eq("leaf-empty", sql.leafOf("nobody"), 0);

console.log("PASS verify-runs");
