// verify-runs.mjs — drives entries.ts against an in-memory fake SQL backend.
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
  const totals = new Map();
  const leafFor = (sid) => entries.reduce((max, e) => (e.sid === sid && e.id > max ? e.id : max), 0);
  return {
    exec(query, ...bindings) {
      const q = String(query);
      if (q.startsWith("PRAGMA")) return [];
      if (q.startsWith("CREATE TABLE")) return [];
      if (q.startsWith("CREATE INDEX")) return [];
      if (q.startsWith("INSERT INTO pi_entries")) {
        seq += 1;
        entries.push({ id: seq, sid: bindings[0], parent: bindings[1], type: bindings[2], body: bindings[3] });
        return [];
      }
      if (q.startsWith("SELECT last_insert_rowid")) return [{ id: seq }];
      if (q.startsWith("SELECT leaf FROM sessions")) {
        return [{ leaf: leafFor(bindings[0]) }];
      }
      if (q.startsWith("SELECT 1 FROM session_totals")) {
        return totals.size > 0 ? [{ one: 1 }] : [];
      }
      if (q.startsWith("SELECT 1 FROM pi_entries WHERE type")) {
        return entries.some((e) => e.type === "result") ? [{ one: 1 }] : [];
      }
      if (q.startsWith("SELECT sid, body FROM pi_entries WHERE type")) {
        return entries.filter((e) => e.type === "result").map((e) => ({ sid: e.sid, body: e.body }));
      }
      if (q.startsWith("INSERT INTO session_totals")) {
        const t = totals.get(bindings[0]) ?? { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, turns: 0 };
        if (q.includes("ON CONFLICT")) {
          t.inTokens += bindings[1];
          t.outTokens += bindings[2];
          t.cacheRead += bindings[3];
          t.costTotal += bindings[4];
          t.elapsedMs += bindings[5];
          t.turns += 1;
        } else {
          t.inTokens = bindings[1];
          t.outTokens = bindings[2];
          t.cacheRead = bindings[3];
          t.costTotal = bindings[4];
          t.elapsedMs = bindings[5];
          t.turns = bindings[6];
        }
        totals.set(bindings[0], t);
        return [];
      }
      if (q.startsWith("UPDATE sessions SET leaf = (SELECT MAX(id)")) return [];
      if (q.startsWith("UPDATE sessions SET leaf")) return [];
      if (q.startsWith("SELECT id AS cursor")) {
        return entries
          .filter((e) => e.sid === bindings[0] && e.id > bindings[1])
          .sort((a, b) => a.id - b.id)
          .slice(0, Math.min(bindings[2] ?? 100, 1000))
          .map((e) => ({ cursor: e.id, type: e.type, body: e.body, parent: e.parent ?? 0 }));
      }
      if (q.startsWith("SELECT COUNT(*) AS count")) {
        const ids = entries.filter((e) => e.sid === bindings[0]).map((e) => e.id);
        return [{ count: ids.length, head: ids.length === 0 ? 0 : Math.max(...ids) }];
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
    transactionSync(fn) {
      fn();
    },
    statusOf(runId) {
      return runs.get(runId)?.status;
    },
    leafOf(sid) {
      return leafFor(sid);
    },
  };
}

const sql = createFakeSql();
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
