// routes.test.mjs — proves the edge forwarder and the inner dispatcher share
// one route table: all 26 forwarded shapes resolve through routes/table.ts
// with byte-identical method plus path plus param mapping, and no route shape
// is declared anywhere else. Imports table.ts only (it has no runtime deps).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORWARD_TABLE, ROUTE, forwardQuery, matchRoute } from "../src/routes/table.ts";

const workerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(workerDir, "src");
const readSrc = (rel) => fs.readFileSync(path.join(srcDir, rel), "utf8");

// The 26 forwarded shapes, in registration order: key plus method plus outer
// path plus inner path plus param mapping, exactly as the legacy double
// declaration served them.
const EXPECTED = [
  { key: "sessions", methods: ["POST"], outer: "/workspaces/:id/sessions", inner: "/sessions", sid: false, query: [], passthrough: false, stream: false },
  { key: "git", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/git", inner: "/git", sid: true, query: [], passthrough: false, stream: false },
  { key: "claim", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/claim", inner: "/claim", sid: true, query: [], passthrough: false, stream: false },
  { key: "model", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/model", inner: "/model", sid: true, query: [], passthrough: false, stream: false },
  { key: "thinking", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/thinking", inner: "/thinking", sid: true, query: [], passthrough: false, stream: false },
  { key: "settings", methods: ["PUT", "GET"], outer: "/workspaces/:id/settings", inner: "/settings", sid: false, query: [], passthrough: false, stream: false },
  { key: "run", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/run", inner: "/run", sid: true, query: [], passthrough: false, stream: false },
  { key: "compact", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/compact", inner: "/compact", sid: true, query: [], passthrough: false, stream: false },
  { key: "archive", methods: ["GET"], outer: "/workspaces/:id/sessions/:sid/archive", inner: "/archive", sid: true, query: ["page"], passthrough: false, stream: false },
  { key: "entries", methods: ["GET"], outer: "/workspaces/:id/sessions/:sid/entries", inner: "/entries", sid: true, query: ["after", "limit"], passthrough: false, stream: false },
  { key: "meta", methods: ["GET"], outer: "/workspaces/:id/sessions/:sid/meta", inner: "/meta", sid: true, query: ["context", "systemPrompt"], passthrough: false, stream: false },
  { key: "doctor", methods: ["GET"], outer: "/workspaces/:id/doctor", inner: "/doctor", sid: false, query: [], passthrough: false, stream: false },
  { key: "fork", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/fork", inner: "/fork", sid: true, query: [], passthrough: false, stream: false },
  { key: "clone", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/clone", inner: "/clone", sid: true, query: [], passthrough: false, stream: false },
  { key: "checkpoints", methods: ["GET", "POST"], outer: "/workspaces/:id/sessions/:sid/checkpoints", inner: "/checkpoints", sid: true, query: [], passthrough: false, stream: false },
  { key: "rewind", methods: ["POST"], outer: "/workspaces/:id/sessions/:sid/rewind", inner: "/rewind", sid: true, query: [], passthrough: false, stream: false },
  { key: "files", methods: ["PUT", "GET", "DELETE"], outer: "/workspaces/:id/files", inner: "/files", sid: false, query: [], passthrough: true, stream: false },
  { key: "exec", methods: ["POST"], outer: "/workspaces/:id/exec", inner: "/exec", sid: false, query: [], passthrough: false, stream: false },
  { key: "execKill", methods: ["POST"], outer: "/workspaces/:id/exec/kill", inner: "/exec/kill", sid: false, query: [], passthrough: false, stream: false },
  { key: "execDispose", methods: ["POST"], outer: "/workspaces/:id/exec/dispose", inner: "/exec/dispose", sid: false, query: [], passthrough: false, stream: false },
  { key: "bgPost", methods: ["POST"], outer: "/workspaces/:id/bg", inner: "/bg", sid: false, query: [], passthrough: false, stream: false },
  { key: "bgGet", methods: ["GET"], outer: "/workspaces/:id/bg", inner: "/bg", sid: false, query: ["handle"], passthrough: false, stream: false },
  { key: "bgKill", methods: ["POST"], outer: "/workspaces/:id/bg/kill", inner: "/bg/kill", sid: false, query: [], passthrough: false, stream: false },
  { key: "stream", methods: ["GET"], outer: "/workspaces/:id/sessions/:sid/stream", inner: "/stream", sid: true, query: [], passthrough: false, stream: true },
  { key: "routines", methods: ["POST", "GET", "DELETE"], outer: "/workspaces/:id/sessions/:sid/routines", inner: "/routines", sid: true, query: ["id"], passthrough: false, stream: false },
  { key: "inbox", methods: ["POST", "GET"], outer: "/workspaces/:id/sessions/:sid/inbox", inner: "/inbox", sid: true, query: ["thread", "all"], passthrough: false, stream: false },
];

test("forward table holds all 26 route shapes byte-identical", () => {
  assert.equal(FORWARD_TABLE.length, 26);
  EXPECTED.forEach((want, i) => {
    const got = FORWARD_TABLE[i];
    assert.deepEqual(
      { methods: [...got.methods], outer: got.outer, inner: got.inner, sid: got.sid, query: [...got.query], passthrough: got.passthrough, stream: got.stream },
      { methods: want.methods, outer: want.outer, inner: want.inner, sid: want.sid, query: want.query, passthrough: want.passthrough, stream: want.stream },
    );
    assert.equal(ROUTE[want.key], got);
  });
});

test("inner-only defs stay out of the forward table", () => {
  assert.deepEqual(
    [ROUTE.create, ROUTE.exists, ROUTE.modelsInner].map((d) => ({ methods: [...d.methods], outer: d.outer, inner: d.inner })),
    [
      { methods: ["POST"], outer: null, inner: "/create" },
      { methods: ["GET"], outer: null, inner: "/exists" },
      { methods: ["GET"], outer: null, inner: "/models" },
    ],
  );
  for (const d of FORWARD_TABLE) assert.notEqual(d.outer, null);
});

test("every route resolves through the single table", () => {
  const cases = [
    ["POST", "/workspaces/w1/sessions", "/sessions"],
    ["POST", "/workspaces/w1/sessions/s1/git", "/git"],
    ["POST", "/workspaces/w1/sessions/s1/claim", "/claim"],
    ["POST", "/workspaces/w1/sessions/s1/model", "/model"],
    ["POST", "/workspaces/w1/sessions/s1/thinking", "/thinking"],
    ["PUT", "/workspaces/w1/settings", "/settings"],
    ["GET", "/workspaces/w1/settings", "/settings"],
    ["POST", "/workspaces/w1/sessions/s1/run", "/run"],
    ["POST", "/workspaces/w1/sessions/s1/compact", "/compact"],
    ["GET", "/workspaces/w1/sessions/s1/archive", "/archive"],
    ["GET", "/workspaces/w1/sessions/s1/entries", "/entries"],
    ["GET", "/workspaces/w1/sessions/s1/meta", "/meta"],
    ["GET", "/workspaces/w1/doctor", "/doctor"],
    ["POST", "/workspaces/w1/sessions/s1/fork", "/fork"],
    ["POST", "/workspaces/w1/sessions/s1/clone", "/clone"],
    ["GET", "/workspaces/w1/sessions/s1/checkpoints", "/checkpoints"],
    ["POST", "/workspaces/w1/sessions/s1/checkpoints", "/checkpoints"],
    ["POST", "/workspaces/w1/sessions/s1/rewind", "/rewind"],
    ["PUT", "/workspaces/w1/files", "/files"],
    ["GET", "/workspaces/w1/files", "/files"],
    ["DELETE", "/workspaces/w1/files", "/files"],
    ["POST", "/workspaces/w1/exec", "/exec"],
    ["POST", "/workspaces/w1/exec/kill", "/exec/kill"],
    ["POST", "/workspaces/w1/exec/dispose", "/exec/dispose"],
    ["POST", "/workspaces/w1/bg", "/bg"],
    ["GET", "/workspaces/w1/bg", "/bg"],
    ["POST", "/workspaces/w1/bg/kill", "/bg/kill"],
    ["GET", "/workspaces/w1/sessions/s1/stream", "/stream"],
    ["POST", "/workspaces/w1/sessions/s1/routines", "/routines"],
    ["GET", "/workspaces/w1/sessions/s1/routines", "/routines"],
    ["DELETE", "/workspaces/w1/sessions/s1/routines", "/routines"],
    ["POST", "/workspaces/w1/sessions/s1/inbox", "/inbox"],
    ["GET", "/workspaces/w1/sessions/s1/inbox", "/inbox"],
  ];
  assert.equal(cases.length, 33);
  for (const [method, concrete, inner] of cases) {
    const def = matchRoute(method, concrete);
    assert.ok(def, `${method} ${concrete} resolves`);
    assert.equal(def.inner, inner);
  }
  assert.equal(matchRoute("GET", "/workspaces/w1/sessions"), undefined);
  assert.equal(matchRoute("POST", "/workspaces/w1/doctor"), undefined);
  assert.equal(matchRoute("DELETE", "/workspaces/w1/sessions/s1/run"), undefined);
  assert.equal(matchRoute("GET", "/workspaces/w1/sessions/s1"), undefined);
  assert.equal(matchRoute("GET", "/models"), undefined);
  assert.equal(matchRoute("GET", "/"), undefined);
});

test("forward query mapping matches the legacy per-route mapping", () => {
  const get = (vals) => (k) => vals[k] ?? undefined;
  assert.deepEqual(forwardQuery(ROUTE.sessions, {}), {});
  assert.deepEqual(forwardQuery(ROUTE.git, { sid: "s1" }), { sid: "s1" });
  assert.deepEqual(forwardQuery(ROUTE.archive, { sid: "s1", get: get({}) }), { sid: "s1", page: undefined });
  assert.deepEqual(forwardQuery(ROUTE.entries, { sid: "s1", get: get({ after: "0", limit: "100" }) }), { sid: "s1", after: "0", limit: "100" });
  assert.deepEqual(forwardQuery(ROUTE.bgGet, { get: get({ handle: "h" }) }), { handle: "h" });
  assert.deepEqual(forwardQuery(ROUTE.bgGet, { get: get({}) }), { handle: undefined });
  assert.deepEqual(forwardQuery(ROUTE.files, { extra: { path: "a.txt" } }), { path: "a.txt" });
  assert.deepEqual(forwardQuery(ROUTE.exec, {}), {});
  assert.deepEqual(forwardQuery(ROUTE.settings, {}), {});
  assert.deepEqual(forwardQuery(ROUTE.doctor, {}), {});
  assert.deepEqual(forwardQuery(ROUTE.routines, { sid: "s1", get: get({ id: "r1" }) }), { sid: "s1", id: "r1" });
});

test("index.ts keeps only its three local routes", () => {
  const indexSrc = readSrc("index.ts");
  const slashStrings = [...indexSrc.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("http"));
  assert.deepEqual([...new Set(slashStrings)].sort(), ["/", "/models", "/workspaces"]);
});

test("every inner path is declared once, in table.ts", () => {
  const allSrc = ["index.ts", "workspace-do.ts", "workspace-base.ts", "routes/table.ts", "routes/files.ts", "routes/sessions.ts", "routes/turns.ts", "routes/ops.ts", "routes/doctor.ts", "routes/_shared.ts"]
    .map(readSrc)
    .join("\n");
  const countQuoted = (literal) => allSrc.split(`"${literal}"`).length - 1;
  const inners = [...new Set([...FORWARD_TABLE.map((d) => d.inner), "/create", "/exists", "/models"])];
  assert.deepEqual(inners.length, 28);
  for (const inner of inners) {
    // "/bg" serves two forward shapes; "/models" is both the edge-local
    // catalog route and an inner path. Everything else appears exactly once.
    const want = inner === "/bg" || inner === "/models" ? 2 : 1;
    assert.equal(countQuoted(inner), want, `${inner} declared ${countQuoted(inner)}x, want ${want}x`);
  }
});

test("every table def is handler-bound exactly once", () => {
  const routeSrcs = ["routes/files.ts", "routes/sessions.ts", "routes/turns.ts", "routes/ops.ts", "routes/doctor.ts", "routes/routines.ts", "routes/inbox.ts"].map(readSrc).join("\n");
  // POST and GET share one bg handler bound through ROUTE.bgPost.
  const unbound = new Set(["bgGet"]);
  for (const key of Object.keys(ROUTE)) {
    const count = routeSrcs.split(`ROUTE.${key},`).length - 1 + routeSrcs.split(`ROUTE.${key} `).length - 1;
    void count;
  }
  for (const key of Object.keys(ROUTE)) {
    const bound = routeSrcs.includes(`registerHandler("files", ROUTE.${key}`)
      || routeSrcs.includes(`registerHandler("sessions", ROUTE.${key}`)
      || routeSrcs.includes(`registerHandler("turns", ROUTE.${key}`)
      || routeSrcs.includes(`registerHandler("ops", ROUTE.${key}`)
      || routeSrcs.includes(`registerHandler("doctor", ROUTE.${key}`)
      || routeSrcs.includes(`registerHandler("routines", ROUTE.${key}`)
      || routeSrcs.includes(`registerHandler("inbox", ROUTE.${key}`);
    assert.equal(bound, !unbound.has(key), `${key} handler binding`);
  }
  for (const [file, owner] of [["routes/files.ts", "files"], ["routes/sessions.ts", "sessions"], ["routes/turns.ts", "turns"], ["routes/ops.ts", "ops"], ["routes/doctor.ts", "doctor"], ["routes/routines.ts", "routines"], ["routes/inbox.ts", "inbox"]]) {
    assert.ok(readSrc(file).includes(`ownedRoutes("${owner}")`), `${file} exports its owned slice`);
  }
});
