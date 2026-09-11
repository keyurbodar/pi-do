// episode.test.mjs — crash-consistency proofs for worker episode state.
//
// Steer queues and the model-fallback flag live in SQLite (pi-cf/store/episode),
// not module Maps, so an isolate restart mid-episode keeps them; redriveTurn
// throw paths report through the sink with named errors. Drives the real
// engine (socketMessage, redriveTurn) over DatabaseSync stores; no mocks.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  ensureEpisodeSchema,
  listSteers,
  setFallback,
  getFallback,
  steerOutcome,
} = await import("pi-cf/store/episode");
const { ensureWorkspaceSchema } = await import("pi-cf/store/sql-util");
const { ensureEntriesSchema, listEntries, openRun } = await import("pi-cf/store/entries");
const engine = await import("../src/stream-engine.ts");

function makeSql(db) {
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
  ensureEpisodeSchema(sql);
  return sql;
}

function fakeHost(sql, sid) {
  return { sql, sid, live: new Map(), sockets: () => [] };
}

function collectSock() {
  return { sent: [], send(frame) { this.sent.push(frame); }, close() {} };
}

// Restart mid-episode proof: seed steers plus the fallback position through
// the engine paths, close the store, then reconstruct the adapter fresh over
// the same file. Queued steers and the fallback row survive.
test("queued steers and fallback position survive a fresh adapter (restart)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "episode-"));
  const path = join(dir, "store.db");
  try {
    {
      const db = new DatabaseSync(path);
      const sql = makeSql(db);
      sql.exec("INSERT OR IGNORE INTO sessions(sid) VALUES (?)", "s1");
      openRun(sql, "s1", "r1");
      const host = fakeHost(sql, "s1");
      const sock = collectSock();
      await engine.socketMessage(host, sock, JSON.stringify({ steer: true, text: "first" }));
      await engine.socketMessage(host, sock, JSON.stringify({ steer: true, text: "second" }));
      assert.equal(sock.sent.at(-1).queued, 2);
      setFallback(sql, "s1", "prov/gone", "prov/kept");
      db.close();
    }
    const db = new DatabaseSync(path);
    try {
      const sql = makeSql(db);
      const host = fakeHost(sql, "s1");
      void host;
      assert.deepEqual(
        listSteers(sql, "r1").map((s) => s.text),
        ["first", "second"],
      );
      assert.deepEqual(steerOutcome(sql, "r1"), { applied: 0, pending: ["first", "second"] });
      assert.deepEqual(
        listEntries(sql, "s1").filter((e) => e.type === "steer").length,
        2,
      );
      assert.deepEqual(getFallback(sql, "s1"), { want: "prov/gone", used: "prov/kept" });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every redriveTurn throw path reports through the sink with a named error
// and still throws for the recovery scan: a missing prompt reports
// redrive_no_prompt, and an unexpected drive failure reports redrive_error.
test("redriveTurn reports throw paths through the sink with named errors", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const sql = makeSql(db);
    const base = { sid: "s1", turnId: "t1", fence: "", cursor: 0, suffix: [], resume: [], nextSeq: 0, fresh: true, skipDeltas: 0 };

    const missing = [];
    const host = { sql, sid: "s1", live: new Map(), enqueue: (fn) => fn() };
    await assert.rejects(
      engine.redriveTurn(host, { ...base, prompt: null }, { report: (f) => missing.push(f) }),
      /redrive needs the turn prompt/,
    );
    assert.equal(missing.length, 1);
    assert.equal(missing[0].error, "redrive_no_prompt");
    assert.equal(missing[0].turnId, "t1");

    const failed = [];
    const badHost = { ...host, live: new Map(), enqueue: () => { throw new Error("boom"); } };
    await assert.rejects(
      engine.redriveTurn(badHost, { ...base, prompt: "hi" }, { report: (f) => failed.push(f) }),
      /boom/,
    );
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error, "redrive_error");
    assert.equal(failed[0].turnId, "t1");
  } finally {
    db.close();
  }
});
