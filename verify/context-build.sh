#!/bin/sh
# context-build.sh — proves MEM-02 summary-before-tail over the real path:
# mint a session, seed past the compact floor (a stub turn persists 6
# entries: prompt, 2x toolCall/toolResult, result; the turn-atomic compact
# is a no-op at 30 live or fewer), run the CLI compact down the same force path
# the alarm runs, append two stub runs with distinct prompts, then feed the
# fetched rows plus the meta leaf into buildSessionContextFromEntries and
# assert the context opens with the compactionSummary followed verbatim by
# the retained seed turns plus the two measured turns, toolCall/toolResult
# projected in cursor order (MEM-04) and nothing left in skipped.
# Keyless stub only: every run must report runtime provider/model stub/stub.
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/context-build/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/context-build"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
PROMPT1="tail prompt alpha ${RUN_ID}"
PROMPT2="tail prompt beta ${RUN_ID}"
export OUT PROMPT1 PROMPT2 RUN_ID

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the turns read"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 seed past the compact floor: 6 stub turns hold 36 live entries"
I=1
while [ "${I}" -le 6 ]; do
  ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "seed turn ${I} ${RUN_ID}" --base "${BASE}" --json > "${OUT}/seed-run-${I}.json" || exit 1
  I=$((I + 1))
done
node -e "
const fs = require('node:fs');
for (let i = 1; i <= 6; i++) {
  const r = JSON.parse(fs.readFileSync('${OUT}/seed-run-' + i + '.json', 'utf8'));
  if (r.runtime.model !== 'stub' || r.runtime.provider !== 'stub') throw new Error('keyless stub only: seed run ' + i + ' model=' + r.runtime.provider + '/' + r.runtime.model);
}
console.log('seed ok: 6 stub turns');
" || exit 1

echo "### 5 CLI compact on the manual force path (same code the alarm runs)"
${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/compact.json" || exit 1
cat "${OUT}/compact.json"
node -e "
const c = require('${OUT}/compact.json');
if (!c.compacted) throw new Error('compact must fire on 36 live entries');
console.log('compact ok: archived ' + c.archived + ' live ' + c.live + ' summary ' + c.summaryCursor);
" || exit 1

echo "### 6 two stub runs with distinct prompts (the measured tail)"
RUNA_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${PROMPT1}" --base "${BASE}" --json)" || exit 1
echo "${RUNA_JSON}"
printf '%s' "${RUNA_JSON}" > "${OUT}/tail-run-1.json"
RUNB_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${PROMPT2}" --base "${BASE}" --json)" || exit 1
echo "${RUNB_JSON}"
printf '%s' "${RUNB_JSON}" > "${OUT}/tail-run-2.json"
node -e "
const a = require('${OUT}/tail-run-1.json');
const b = require('${OUT}/tail-run-2.json');
for (const [n, r] of [['tail-1', a], ['tail-2', b]]) {
  if (r.runtime.model !== 'stub' || r.runtime.provider !== 'stub') throw new Error('keyless stub only: ' + n + ' model=' + r.runtime.provider + '/' + r.runtime.model);
  console.log(n + ' via=' + r.runtime.via + ' model=' + r.runtime.provider + '/' + r.runtime.model);
}
" || exit 1

echo "### 7 fetch entries (limit 100) plus the meta leaf"
# One pair, no polling: an alarm compaction after the last turn can leave a
# trailing summary above the leaf (head > leaf) as a stable state. The builder
# walks back from the leaf and never visits it, so the check walks the same
# chain instead of demanding leaf === last cursor.
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 100 --base "${BASE}" --json > "${OUT}/entries.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta.json" || exit 1
node -p "'entries=' + require('${OUT}/entries.json').entries.length + ' leaf=' + require('${OUT}/meta.json').leaf"

echo "### 8 buildSessionContextFromEntries over the real rows: summary before tail"
cat > "${OUT}/check.mjs" <<'EOF'
import fs from "node:fs";
import { buildSessionContextFromEntries } from "../../../packages/pi-cf/src/agent/context.ts";
const out = process.env.OUT;
const prompt1 = process.env.PROMPT1;
const prompt2 = process.env.PROMPT2;
const runId = process.env.RUN_ID;
const rows = JSON.parse(fs.readFileSync(`${out}/entries.json`, "utf8")).entries;
const leaf = JSON.parse(fs.readFileSync(`${out}/meta.json`, "utf8")).leaf;
const runA = JSON.parse(fs.readFileSync(`${out}/tail-run-1.json`, "utf8"));
const runB = JSON.parse(fs.readFileSync(`${out}/tail-run-2.json`, "utf8"));
if (typeof leaf !== "number" || leaf <= 0) throw new Error("meta leaf must be a positive cursor");
if (rows.length === 0) throw new Error("entries fetch must be non-empty");
const at = rows.map((e, i) => (e.type === "compaction" ? i : -1)).filter((i) => i >= 0);
// Slow inference lets the alarm compact more than once mid-setup. Stacked
// summaries are legal, and the builder windows from the latest compaction it
// can reach by walking parents back from the leaf, so the check walks the
// same chain instead of assuming id order.
if (at.length < 1) throw new Error("expected at least one compaction entry, got 0");
const byCursor = new Map(rows.map((e) => [e.cursor, e]));
const chain = [];
{
  let c = leaf;
  const seen = new Set();
  while (Number.isInteger(c) && c > 0 && !seen.has(c)) {
    const e = byCursor.get(c);
    if (!e) break;
    seen.add(c);
    chain.push(e);
    const p = e.parent;
    if (typeof p !== "number" || !Number.isInteger(p) || p <= 0) break;
    c = p;
  }
  chain.reverse();
}
let ws = -1;
chain.forEach((e, i) => { if (e.type === "compaction") ws = i; });
if (ws < 0) throw new Error("no compaction reachable from the leaf");
// A trailing summary above the leaf (alarm fired after the last turn) sits in
// live rows but outside the walked chain. The builder never visits it, so the
// window only has to be a fetched summary, not the latest one.
if (!at.some((i) => rows[i].cursor === chain[ws].cursor)) throw new Error("chain window is not a fetched summary");
if (ws >= chain.length - 1) throw new Error("compaction must sit mid-chain, nothing after it");
console.log("chain ok: " + rows.length + " entries, " + at.length + " summaries, window at cursor " + chain[ws].cursor + " with " + (chain.length - ws - 1) + " tail rows");
const ctx = buildSessionContextFromEntries(rows, leaf);
const first = ctx.messages[0];
if (first.cursor !== chain[ws].cursor) throw new Error("first message must be the window summary");
console.log("summary message first: role=compactionSummary cursor=" + first.cursor + " chars=" + first.text.length);
console.log("--- summary text ---");
console.log(first.text);
console.log("--- tail ---");
const tail = ctx.messages.slice(1);
const summaryCursor = chain[ws].cursor;
// The tail is the walked chain after the window: retained seed turns (which
// sit before the summary in id order) plus the measured turns after it.
const tailRows = chain.slice(ws + 1);
if (tail.length !== tailRows.length) {
  throw new Error("every tail entry must project, messages " + tail.length + " rows " + tailRows.length);
}
let seenPrompt = 0;
let seenResult = 0;
const gotMeasuredPrompts = [];
const gotMeasuredResults = [];
// Turns are atomic: a compaction never splits one, so every result in the
// window shares it with its turn prompt. A result belongs to a measured turn
// exactly when that prompt carries a live measured text. Seed and measured
// results are text-identical stubs, so cursor order, not text, decides.
let turnPrompt = null;
for (let i = 0; i < tailRows.length; i++) {
  const row = tailRows[i];
  const body = JSON.parse(row.body);
  const msg = tail[i];
  if (msg.cursor !== row.cursor) throw new Error("tail[" + i + "] cursor " + msg.cursor + " want " + row.cursor);
  if (row.type === "prompt") {
    seenPrompt++;
    if (msg.role !== "user") throw new Error("tail[" + i + "] prompt projects as user");
    if (msg.text === prompt1 || msg.text === prompt2) gotMeasuredPrompts.push(msg.text);
    else if (msg.text !== "seed turn " + Math.ceil(row.cursor / 6) + " " + runId) throw new Error("tail[" + i + "] seed prompt keeps its live text");
    turnPrompt = msg.text;
  } else if (row.type === "result") {
    seenResult++;
    if (msg.role !== "assistant") throw new Error("tail[" + i + "] result projects as assistant");
    if (turnPrompt === null) throw new Error("tail[" + i + "] result precedes its turn prompt");
    if (turnPrompt === prompt1 || turnPrompt === prompt2) gotMeasuredResults.push(msg.text);
    else if (typeof msg.text !== "string" || msg.text.length === 0) throw new Error("tail[" + i + "] seed result is non-empty text");
    } else if (row.type === "toolCall") {
    if (msg.role !== "toolCall") throw new Error("tail[" + i + "] role " + msg.role + " want toolCall");
    if (typeof body.tool !== "string" || !msg.text.startsWith(body.tool)) throw new Error("tail[" + i + "] toolCall text starts with the live tool name");
  } else if (row.type === "toolResult") {
    if (msg.role !== "toolResult") throw new Error("tail[" + i + "] role " + msg.role + " want toolResult");
    if (msg.text !== body.output) throw new Error("tail[" + i + "] toolResult text equals the live output");
  } else {
    throw new Error("tail[" + i + "] unexpected type " + row.type);
  }
  console.log("tail[" + i + "] " + msg.role + " cursor=" + msg.cursor + ": " + JSON.stringify(msg.text).slice(0, 160));
}
// The re-root puts the summary (parent 0) before the retained tail in message
// order, so monotonic cursor order is asserted across the tail itself; the
// per-row check above already pins each message to its row cursor.
for (let i = 1; i < tail.length; i++) {
  if (!(tail[i].cursor > tail[i - 1].cursor)) throw new Error("messages must run in cursor order");
}
// The window may cut a prefix off the measured turns. What remains must be
// the ordered suffix of the two live prompts and results.
const wantPrompts = [prompt1, prompt2].slice(2 - gotMeasuredPrompts.length);
const wantResults = [runA.result, runB.result].slice(2 - gotMeasuredResults.length);
if (JSON.stringify(gotMeasuredPrompts) !== JSON.stringify(wantPrompts)) throw new Error("measured prompts must be the live suffix, got " + JSON.stringify(gotMeasuredPrompts));
if (JSON.stringify(gotMeasuredResults) !== JSON.stringify(wantResults)) throw new Error("measured results must be the live suffix, got " + gotMeasuredResults.length + " rows");
console.log("tail ok: " + seenPrompt + " turns project in cursor order (retained seed turns plus the two measured turns), tools paired");
if (!Array.isArray(ctx.skipped) || ctx.skipped.length !== 0) throw new Error("skipped must be empty, got " + JSON.stringify(ctx.skipped));
console.log("skipped ok: empty, every entry projected");
if (ctx.model !== null) throw new Error("keyless stub path must leave model null");
if (ctx.thinking !== "off") throw new Error("no thinking switch means thinking off, got " + ctx.thinking);
if (ctx.toolNames !== null) throw new Error("toolNames stays null (MEM-06 owns budgets)");
console.log("config ok: model null, thinking off, toolNames null");
EOF
node "${OUT}/check.mjs" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
