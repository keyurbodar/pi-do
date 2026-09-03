// verify-extensions.mjs — battery for inline extensions (PR19). Builds a
// foreign host (createPiCf with the sample extension) over node:sqlite and
// drives its real fetch surface: one keyless stub turn must invoke the sample
// tool, the entries re-read must show the tool call plus result, the registry
// must list the sample command, and the turn result must carry the hook
// marker. Exit nonzero on the first gap.
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPiCf } from "./src/index.ts";
import {
  createSampleInlineExtension,
  loadInlineExtensions,
  SAMPLE_COMMAND_NAME,
  SAMPLE_HOOK_MARKER,
  SAMPLE_TOOL_NAME,
  SAMPLE_TOOL_OUTPUT,
} from "./src/extensions.ts";

const RUN_ID = process.env.RUN_ID ?? `verify-${Date.now()}`;
const OUT = `artifacts/${RUN_ID}/extensions-inline`;
mkdirSync(OUT, { recursive: true });

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

const Host = createPiCf({ model: { id: "stub" }, extensions: [createSampleInlineExtension()] });
const host = new Host({ storage: { sql: createSql() } });

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

const WS = `verify-ext-${Date.now()}`;
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

console.log("### 3 mint a session on the foreign host");
let SID = "";
{
  const { status, json } = await req("POST", `/sessions?ws=${WS}`);
  if (status !== 200 || typeof json.sessionId !== "string") fail("session", "sessionId", JSON.stringify(json));
  SID = json.sessionId;
}

console.log("### 4 one keyless stub turn invokes the sample tool (action)");
let run;
{
  const { status, json } = await req("POST", `/run?ws=${WS}&sid=${SID}`, { prompt: "read seed.txt" });
  if (status !== 200) fail("run", 200, `${status} ${JSON.stringify(json)}`);
  run = json;
  writeFileSync(`${OUT}/run.json`, `${JSON.stringify(run, null, 2)}\n`);
  const names = (run.toolCalls ?? []).map((c) => c.tool);
  for (const want of ["read", "bash", SAMPLE_TOOL_NAME]) {
    if (!names.includes(want)) fail("run toolCalls", `to include ${want}`, names.join(","));
  }
  const ext = run.toolCalls.find((c) => c.tool === SAMPLE_TOOL_NAME);
  if (ext.output !== SAMPLE_TOOL_OUTPUT) fail("sample tool output", SAMPLE_TOOL_OUTPUT, ext.output);
  if (typeof run.result !== "string" || !run.result.includes(SEED)) fail("run result", "seeded read output", run.result);
  if (!run.result.includes(SAMPLE_HOOK_MARKER)) fail("run result", SAMPLE_HOOK_MARKER, run.result);
  console.log(`run ok: read+bash+${SAMPLE_TOOL_NAME}, hook marker present`);
}

console.log("### 5 entries re-read shows the tool call plus result (second view)");
{
  const { status, json } = await req("GET", `/entries?ws=${WS}&sid=${SID}&after=0&limit=100`);
  if (status !== 200 || !Array.isArray(json.entries)) fail("entries", "entries array", JSON.stringify(json));
  writeFileSync(`${OUT}/entries.json`, `${JSON.stringify(json, null, 2)}\n`);
  const calls = json.entries.filter((e) => e.type === "toolCall").map((e) => JSON.parse(e.body));
  const results = json.entries.filter((e) => e.type === "toolResult").map((e) => JSON.parse(e.body));
  const call = calls.find((c) => c.tool === SAMPLE_TOOL_NAME);
  const result = results.find((r) => r.tool === SAMPLE_TOOL_NAME);
  if (!call) fail("entries toolCall", SAMPLE_TOOL_NAME, calls.map((c) => c.tool).join(","));
  if (!result || result.output !== SAMPLE_TOOL_OUTPUT) {
    fail("entries toolResult", SAMPLE_TOOL_OUTPUT, JSON.stringify(result));
  }
  if (call.id !== result.id) fail("entries id link", call.id, result.id);
  console.log("entries ok: sample toolCall + toolResult persisted and linked");
}

console.log("### 6 command map lists the sample command");
{
  const loaded = await loadInlineExtensions([createSampleInlineExtension()]);
  const names = [...loaded.commands.keys()];
  if (!names.includes(SAMPLE_COMMAND_NAME)) fail("commands", `to include ${SAMPLE_COMMAND_NAME}`, names.join(","));
  const out = await loaded.commands.get(SAMPLE_COMMAND_NAME).handler("");
  writeFileSync(`${OUT}/commands.json`, `${JSON.stringify({ commands: names, handlerOutput: out }, null, 2)}\n`);
  if (typeof out !== "string" || out.length === 0) fail("command handler", "non-empty output", JSON.stringify(out));
  console.log(`commands ok: ${names.join(",")} -> ${out}`);
}

console.log(`PASS ${RUN_ID} ws=${WS} sid=${SID}`);
