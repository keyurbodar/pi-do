// verify-ext-vfs.mjs — battery for VFS extensions (PR21a). Builds a foreign
// host (createPiCf with no inline extensions) over node:sqlite and drives its
// real fetch surface: PUT a sample extension file into .pi/extensions via the
// files route, GET it back, run one keyless stub turn invoking its tool, prove
// entries show the call plus result, prove the command map lists its command,
// then DELETE the file and prove the next turn no longer has the tool.
// Exit nonzero on the first gap.
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPiCf } from "./src/index.ts";
import { createDofsVfs } from "./src/vfs-dofs.ts";
import { ComputerExecutionEnv } from "./src/env.ts";
import { loadInlineExtensions } from "./src/extensions.ts";
import { loadVfsExtensionFactories } from "./src/loader.ts";

const RUN_ID = process.env.RUN_ID ?? `verify-${Date.now()}`;
const OUT = `artifacts/${RUN_ID}/ext-vfs`;
mkdirSync(OUT, { recursive: true });

const EXT_PATH = ".pi/extensions/verify-note.ts";
const EXT_TOOL = "ext_vfs_note";
const EXT_OUTPUT = "vfs extension tool ok";
const EXT_COMMAND = "ext_vfs_hello";
const EXT_CMD_OUTPUT = "hello from vfs extension";
const EXT_HOOK = "hook-fired:vfs-turn_end";

const EXT_SOURCE = [
  'api.registerTool({',
  `  name: "${EXT_TOOL}",`,
  '  description: "Sample VFS-extension tool: returns a fixed marker proving the VFS tool path runs.",',
  '  execute: () => "vfs extension tool ok",',
  "});",
  `api.registerCommand("${EXT_COMMAND}", {`,
  '  description: "Sample VFS-extension command.",',
  '  handler: () => "hello from vfs extension",',
  "});",
  `api.on("turn_end", () => "${EXT_HOOK}");`,
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

async function reqText(method, path, body) {
  const init = { method };
  if (body !== undefined) init.body = body;
  const res = await host.fetch(new Request(`http://foreign${path}`, init));
  return { status: res.status, text: await res.text() };
}

const WS = `verify-extvfs-${Date.now()}`;
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

console.log(`### 3 PUT the extension file via the files route, GET it back (second view)`);
{
  const { status } = await req("PUT", `/files?ws=${WS}&path=${EXT_PATH}`, EXT_SOURCE);
  if (status !== 200) fail("ext put", 200, status);
  const got = await reqText("GET", `/files?ws=${WS}&path=${EXT_PATH}`);
  if (got.status !== 200 || got.text !== EXT_SOURCE) {
    fail("ext get", "the exact source back", `${got.status} ${got.text.slice(0, 120)}`);
  }
  console.log("extension file round-trips through the files route");
}

console.log("### 4 mint a session on the foreign host");
let SID = "";
{
  const { status, json } = await req("POST", `/sessions?ws=${WS}`);
  if (status !== 200 || typeof json.sessionId !== "string") fail("session", "sessionId", JSON.stringify(json));
  SID = json.sessionId;
}

console.log("### 5 one keyless stub turn invokes the VFS tool (action)");
let run;
{
  const { status, json } = await req("POST", `/run?ws=${WS}&sid=${SID}`, { prompt: "read seed.txt" });
  if (status !== 200) fail("run", 200, `${status} ${JSON.stringify(json)}`);
  run = json;
  writeFileSync(`${OUT}/run.json`, `${JSON.stringify(run, null, 2)}\n`);
  const names = (run.toolCalls ?? []).map((c) => c.tool);
  for (const want of ["read", "bash", EXT_TOOL]) {
    if (!names.includes(want)) fail("run toolCalls", `to include ${want}`, names.join(","));
  }
  const ext = run.toolCalls.find((c) => c.tool === EXT_TOOL);
  if (ext.output !== EXT_OUTPUT) fail("vfs tool output", EXT_OUTPUT, ext.output);
  if (typeof run.result !== "string" || !run.result.includes(SEED)) fail("run result", "seeded read output", run.result);
  if (!run.result.includes(EXT_HOOK)) fail("run result", EXT_HOOK, run.result);
  console.log(`run ok: read+bash+${EXT_TOOL}, hook marker present`);
}

console.log("### 6 entries re-read shows the tool call plus result (second view)");
{
  const { status, json } = await req("GET", `/entries?ws=${WS}&sid=${SID}&after=0&limit=100`);
  if (status !== 200 || !Array.isArray(json.entries)) fail("entries", "entries array", JSON.stringify(json));
  writeFileSync(`${OUT}/entries.json`, `${JSON.stringify(json, null, 2)}\n`);
  const calls = json.entries.filter((e) => e.type === "toolCall").map((e) => JSON.parse(e.body));
  const results = json.entries.filter((e) => e.type === "toolResult").map((e) => JSON.parse(e.body));
  const call = calls.find((c) => c.tool === EXT_TOOL);
  const result = results.find((r) => r.tool === EXT_TOOL);
  if (!call) fail("entries toolCall", EXT_TOOL, calls.map((c) => c.tool).join(","));
  if (!result || result.output !== EXT_OUTPUT) {
    fail("entries toolResult", EXT_OUTPUT, JSON.stringify(result));
  }
  if (call.id !== result.id) fail("entries id link", call.id, result.id);
  console.log("entries ok: VFS toolCall + toolResult persisted and linked");
}

console.log("### 7 command map lists the VFS command (same registry as inline)");
{
  const store = createDofsVfs(sql);
  const env = new ComputerExecutionEnv(store, WS);
  const loaded = await loadInlineExtensions(loadVfsExtensionFactories(store, WS, { env }));
  const names = [...loaded.commands.keys()];
  if (!names.includes(EXT_COMMAND)) fail("commands", `to include ${EXT_COMMAND}`, names.join(","));
  const out = await loaded.commands.get(EXT_COMMAND).handler("");
  writeFileSync(`${OUT}/commands.json`, `${JSON.stringify({ commands: names, handlerOutput: out }, null, 2)}\n`);
  if (out !== EXT_CMD_OUTPUT) fail("command handler", EXT_CMD_OUTPUT, JSON.stringify(out));
  console.log(`commands ok: ${names.join(",")} -> ${out}`);
}

console.log("### 8 DELETE the file, prove it is gone, prove the next turn drops the tool");
{
  const { status, json } = await req("DELETE", `/files?ws=${WS}&path=${EXT_PATH}`);
  if (status !== 200) fail("ext delete", 200, `${status} ${JSON.stringify(json)}`);
  writeFileSync(`${OUT}/removed.json`, `${JSON.stringify(json, null, 2)}\n`);
  const gone = await req("GET", `/files?ws=${WS}&path=${EXT_PATH}`);
  if (gone.status !== 404) fail("ext get after delete", 404, gone.status);
  const second = await req("POST", `/run?ws=${WS}&sid=${SID}`, { prompt: "read seed.txt" });
  if (second.status !== 200) fail("second run", 200, `${second.status} ${JSON.stringify(second.json)}`);
  writeFileSync(`${OUT}/run2.json`, `${JSON.stringify(second.json, null, 2)}\n`);
  const names = (second.json.toolCalls ?? []).map((c) => c.tool);
  if (names.includes(EXT_TOOL)) fail("second run toolCalls", `to drop ${EXT_TOOL}`, names.join(","));
  if (typeof second.json.result === "string" && second.json.result.includes(EXT_HOOK)) {
    fail("second run result", `to drop ${EXT_HOOK}`, second.json.result.slice(0, 200));
  }
  console.log("removal ok: file 404s, next turn has no VFS tool and no hook marker");
}

console.log(`PASS ${RUN_ID} ws=${WS} sid=${SID}`);
