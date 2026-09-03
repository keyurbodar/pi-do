// verify-ext-manifest.mjs — battery for manifest-form VFS extensions (PR21c).
// Builds a foreign host (createPiCf with no inline extensions) over
// node:sqlite and drives its real fetch surface: PUT a manifest subdir
// (package.json with pi.extensions plus its entry file) and a direct .ts
// file into .pi/extensions via the files route, run one keyless stub turn
// invoking both tools, prove entries show the calls plus results, prove the
// command map lists both commands, then prove a bad manifest fails the turn
// with a hint naming its own subdir and that deleting it restores the turn
// with both good tools. Exit nonzero on the first gap.
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPiCf } from "./src/index.ts";
import { createDofsVfs } from "./src/vfs-dofs.ts";
import { ComputerExecutionEnv } from "./src/env.ts";
import { loadInlineExtensions } from "./src/extensions.ts";
import { loadVfsExtensionFactories } from "./src/loader.ts";

const RUN_ID = process.env.RUN_ID ?? `verify-${Date.now()}`;
const OUT = `artifacts/${RUN_ID}/ext-manifest`;
mkdirSync(OUT, { recursive: true });

const SUB = ".pi/extensions/manifest-note";
const MANIFEST_PATH = `${SUB}/package.json`;
const ENTRY_PATH = `${SUB}/entry.js`;
const MANIFEST_TOOL = "ext_manifest_note";
const MANIFEST_OUTPUT = "manifest extension tool ok";
const MANIFEST_COMMAND = "ext_manifest_hello";
const MANIFEST_CMD_OUTPUT = "hello from manifest extension";
const MANIFEST_HOOK = "hook-fired:manifest-turn_end";
const DIRECT_PATH = ".pi/extensions/direct-note.ts";
const DIRECT_TOOL = "ext_direct_note";
const DIRECT_OUTPUT = "direct extension tool ok";
const BAD_SUB = ".pi/extensions/broken-note";
const BAD_PATH = `${BAD_SUB}/package.json`;

const MANIFEST_JSON = JSON.stringify({ name: "manifest-note", pi: { extensions: ["entry.js"] } });
const ENTRY_SOURCE = [
  'api.registerTool({',
  `  name: "${MANIFEST_TOOL}",`,
  '  description: "Sample manifest-extension tool: returns a fixed marker proving the manifest path runs.",',
  '  execute: () => "manifest extension tool ok",',
  "});",
  `api.registerCommand("${MANIFEST_COMMAND}", {`,
  '  description: "Sample manifest-extension command.",',
  '  handler: () => "hello from manifest extension",',
  "});",
  `api.on("turn_end", () => "${MANIFEST_HOOK}");`,
  "",
].join("\n");
const DIRECT_SOURCE = [
  'api.registerTool({',
  `  name: "${DIRECT_TOOL}",`,
  '  description: "Sample direct-file tool: proves direct .ts files keep working beside manifests.",',
  '  execute: () => "direct extension tool ok",',
  "});",
  "",
].join("\n");

function fail(step, want, got) {
  console.error(`FAIL ${step}: want ${want} got ${got}`);
  process.exit(1);
}

function createSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      if (/^\s*(SELECT|WITH)\b/i.test(query)) return db.prepare(query).all(...bindings);
      db.prepare(query).run(...bindings);
      return [];
    },
  };
}

const sql = createSql();
const Host = createPiCf({ model: { id: "stub" } });
const host = new Host({ storage: { sql } });

async function req(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await host.fetch(new Request(`http://foreign${path}`, init));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${method} ${path}`, "JSON body", text.slice(0, 200));
  }
  return { status: res.status, json, text };
}

const WS = `verify-extmanifest-${Date.now()}`;
const SEED = `seeded-body-${RUN_ID}`;
console.log(`### 1 foreign host creates a fresh workspace ${WS}`);
{
  const { status, json } = await req("POST", "/create", { workspaceId: WS });
  if (status !== 200 || json.workspaceId !== WS) fail("create", WS, JSON.stringify(json));
}

console.log("### 2 seed the file the stub reads");
{
  const { status } = await req("PUT", `/files?ws=${WS}&path=seed.txt`, SEED);
  if (status !== 200) fail("seed put", 200, status);
}

console.log("### 3 PUT the manifest subdir plus a direct .ts file via the files route");
{
  for (const [path, body] of [[MANIFEST_PATH, MANIFEST_JSON], [ENTRY_PATH, ENTRY_SOURCE], [DIRECT_PATH, DIRECT_SOURCE]]) {
    const { status } = await req("PUT", `/files?ws=${WS}&path=${path}`, body);
    if (status !== 200) fail(`put ${path}`, 200, status);
  }
  console.log("manifest subdir plus direct file stored");
}

console.log("### 4 mint a session on the foreign host");
let SID = "";
{
  const { status, json } = await req("POST", `/sessions?ws=${WS}`);
  if (status !== 200 || typeof json.sessionId !== "string") fail("session", "sessionId", JSON.stringify(json));
  SID = json.sessionId;
}

console.log("### 5 one keyless stub turn invokes the manifest tool and the direct tool (action)");
let run;
{
  const { status, json } = await req("POST", `/run?ws=${WS}&sid=${SID}`, { prompt: "read seed.txt" });
  if (status !== 200) fail("run", 200, `${status} ${JSON.stringify(json)}`);
  run = json;
  writeFileSync(`${OUT}/run.json`, `${JSON.stringify(run, null, 2)}\n`);
  const names = (run.toolCalls ?? []).map((c) => c.tool);
  for (const want of ["read", "bash", MANIFEST_TOOL, DIRECT_TOOL]) {
    if (!names.includes(want)) fail("run toolCalls", `to include ${want}`, names.join(","));
  }
  const ext = run.toolCalls.find((c) => c.tool === MANIFEST_TOOL);
  if (ext.output !== MANIFEST_OUTPUT) fail("manifest tool output", MANIFEST_OUTPUT, ext.output);
  if (!run.result.includes(MANIFEST_HOOK)) fail("run result", MANIFEST_HOOK, run.result);
  console.log(`run ok: read+bash+${MANIFEST_TOOL}+${DIRECT_TOOL}, manifest hook marker present`);
}

console.log("### 6 entries re-read shows the manifest tool call plus result (second view)");
{
  const { status, json } = await req("GET", `/entries?ws=${WS}&sid=${SID}&after=0&limit=100`);
  if (status !== 200 || !Array.isArray(json.entries)) fail("entries", "entries array", JSON.stringify(json));
  writeFileSync(`${OUT}/entries.json`, `${JSON.stringify(json, null, 2)}\n`);
  const calls = json.entries.filter((e) => e.type === "toolCall").map((e) => JSON.parse(e.body));
  const results = json.entries.filter((e) => e.type === "toolResult").map((e) => JSON.parse(e.body));
  const call = calls.find((c) => c.tool === MANIFEST_TOOL);
  const result = results.find((r) => r.tool === MANIFEST_TOOL);
  if (!call) fail("entries toolCall", MANIFEST_TOOL, calls.map((c) => c.tool).join(","));
  if (!result || result.output !== MANIFEST_OUTPUT) {
    fail("entries toolResult", MANIFEST_OUTPUT, JSON.stringify(result));
  }
  if (call.id !== result.id) fail("entries id link", call.id, result.id);
  console.log("entries ok: manifest toolCall + toolResult persisted and linked");
}

console.log("### 7 command map lists the manifest command (same registry as inline)");
{
  const store = createDofsVfs(sql);
  const env = new ComputerExecutionEnv(store, WS);
  const loaded = await loadInlineExtensions(loadVfsExtensionFactories(store, WS, { env }));
  const names = [...loaded.commands.keys()];
  if (!names.includes(MANIFEST_COMMAND)) fail("commands", `to include ${MANIFEST_COMMAND}`, names.join(","));
  const out = await loaded.commands.get(MANIFEST_COMMAND).handler("");
  writeFileSync(`${OUT}/commands.json`, `${JSON.stringify({ commands: names, handlerOutput: out }, null, 2)}\n`);
  if (out !== MANIFEST_CMD_OUTPUT) fail("command handler", MANIFEST_CMD_OUTPUT, JSON.stringify(out));
  console.log(`commands ok: ${names.join(",")} -> ${out}`);
}

console.log("### 8 bad manifest fails the turn with a hint naming its own subdir (fail-closed)");
{
  const { status } = await req("PUT", `/files?ws=${WS}&path=${BAD_PATH}`, "{not json");
  if (status !== 200) fail("bad manifest put", 200, status);
  const bad = await req("POST", `/run?ws=${WS}&sid=${SID}`, { prompt: "read seed.txt" });
  writeFileSync(`${OUT}/bad.json`, `${JSON.stringify(bad.json, null, 2)}\n`);
  if (bad.status !== 500) fail("bad manifest run", 500, `${bad.status} ${JSON.stringify(bad.json)}`);
  if (typeof bad.json.error !== "string" || !bad.json.error.includes(BAD_SUB)) {
    fail("bad manifest error", `to name ${BAD_SUB}`, JSON.stringify(bad.json));
  }
  if (typeof bad.json.hint !== "string" || bad.json.hint.length === 0) {
    fail("bad manifest hint", "a non-empty hint", JSON.stringify(bad.json));
  }
  console.log(`fail-closed ok: ${bad.json.error} + hint`);
}

console.log("### 9 deleting only the bad subdir restores the turn with both good tools");
{
  const { status, json } = await req("DELETE", `/files?ws=${WS}&path=${BAD_SUB}&recursive=true`);
  if (status !== 200) fail("bad subdir delete", 200, `${status} ${JSON.stringify(json)}`);
  writeFileSync(`${OUT}/removed.json`, `${JSON.stringify(json, null, 2)}\n`);
  const second = await req("POST", `/run?ws=${WS}&sid=${SID}`, { prompt: "read seed.txt" });
  if (second.status !== 200) fail("second run", 200, `${second.status} ${JSON.stringify(second.json)}`);
  writeFileSync(`${OUT}/run2.json`, `${JSON.stringify(second.json, null, 2)}\n`);
  const names = (second.json.toolCalls ?? []).map((c) => c.tool);
  for (const want of [MANIFEST_TOOL, DIRECT_TOOL]) {
    if (!names.includes(want)) fail("second run toolCalls", `to include ${want}`, names.join(","));
  }
  if (typeof second.json.result !== "string" || !second.json.result.includes(MANIFEST_HOOK)) {
    fail("second run result", MANIFEST_HOOK, (second.json.result ?? "").slice(0, 200));
  }
  console.log("recovery ok: bad subdir gone, manifest plus direct tools invoke again");
}

console.log(`PASS ${RUN_ID} ws=${WS} sid=${SID}`);
