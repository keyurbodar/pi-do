// verify-runs.mjs — drives entries.ts against an in-memory fake SQL backend.
// Proves crashed runs flip to interrupted on next open while clean runs
// never produce false interrupted entries. Exit nonzero on the first gap.
import {
  appendEntry,
  closeRun,
  ensureEntriesSchema,
  listEntries,
  openRun,
  recordTurn,
} from "../../worker/src/entries.ts";

function fail(step, want, got) {
  console.error(`FAIL ${step}: want ${want} got ${got}`);
  process.exit(1);
}

function eq(step, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(step, b, a);
}

function createFakeSql() {
  let seq = 0;
  const entries = [];
  const runs = new Map();
  return {
    exec(query, ...bindings) {
      const q = String(query);
      if (q.startsWith("CREATE TABLE")) return [];
      if (q.startsWith("INSERT INTO pi_entries")) {
        seq += 1;
        entries.push({ id: seq, sid: bindings[0], type: bindings[1], body: bindings[2] });
        return [];
      }
      if (q.startsWith("SELECT last_insert_rowid")) return [{ id: seq }];
      if (q.startsWith("UPDATE pi_entries SET cursor")) {
        const row = entries.find((e) => e.id === bindings[1]);
        if (row) row.cursor = bindings[0];
        return [];
      }
      if (q.startsWith("SELECT id AS cursor")) {
        return entries
          .filter((e) => e.sid === bindings[0] && e.id > bindings[1])
          .sort((a, b) => a.id - b.id)
          .map((e) => ({ cursor: e.id, type: e.type, body: e.body }));
      }
      if (q.startsWith("SELECT runId FROM runs")) {
        return [...runs.values()]
          .filter((r) => r.sid === bindings[0] && r.status === bindings[1])
          .map((r) => ({ runId: r.runId }));
      }
      if (q.startsWith("INSERT OR REPLACE INTO runs")) {
        runs.set(bindings[1], { sid: bindings[0], runId: bindings[1], status: bindings[2] });
        return [];
      }
      if (q.startsWith("UPDATE runs SET status")) {
        const r = runs.get(bindings[2]);
        if (r && r.sid === bindings[1]) r.status = bindings[0];
        return [];
      }
      fail("fake-exec", "known query", q);
      return [];
    },
    statusOf(runId) {
      return runs.get(runId)?.status;
    },
  };
}

const sql = createFakeSql();
ensureEntriesSchema(sql);

// Clean path: open, record a full turn, close, open next — no interrupted entries.
openRun(sql, "s1", "r1");
eq("r1-open", sql.statusOf("r1"), "open");
recordTurn(
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

// Crash path: r2 never closes; opening r3 flips r2 to interrupted with one entry.
openRun(sql, "s1", "r3");
eq("r2-interrupted", sql.statusOf("r2"), "interrupted");
eq("r3-open", sql.statusOf("r3"), "open");
const interrupted = listEntries(sql, "s1").filter((e) => e.type === "interrupted");
eq("interrupted-count", interrupted.length, 1);
eq("interrupted-body", JSON.parse(interrupted[0].body), { runId: "r2", interruptedBy: "r3" });

// Cursor order: consecutive from 1 with no gaps; after-filter replays the tail.
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

// appendEntry returns the rowid cursor and stores strings verbatim.
const c = appendEntry(sql, "s2", "prompt", "raw-string");
eq("raw-cursor", c, 6);
eq("raw-body", listEntries(sql, "s2"), [{ cursor: 6, type: "prompt", body: "raw-string" }]);

// Closing an unknown run is a no-op, never an interrupted entry.
closeRun(sql, "s1", "nope");
eq(
  "close-unknown-clean",
  listEntries(sql, "s1").filter((e) => e.type === "interrupted").length,
  1,
);

console.log("PASS verify-runs");
