#!/bin/sh
# context-build.sh — proves MEM-02 summary-before-tail over the real path:
# mint a session, seed past the compact floor (a stub turn persists 6
# entries: prompt, 2x toolCall/toolResult, result; the manual compact is a
# no-op at 26 live or fewer), run the CLI compact down the same force path
# the alarm runs, append two stub runs with distinct prompts, then feed the
# fetched rows plus the meta leaf into buildSessionContextFromEntries and
# assert the context opens with the compactionSummary followed verbatim by
# the two-turn tail while toolCall/toolResult land in skipped as unprojected.
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
export OUT PROMPT1 PROMPT2

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

echo "### 4 seed past the compact floor: 5 stub turns hold 30 live entries"
I=1
while [ "${I}" -le 5 ]; do
  ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "seed turn ${I} ${RUN_ID}" --base "${BASE}" --json > "${OUT}/seed-run-${I}.json" || exit 1
  I=$((I + 1))
done
node -e "
const fs = require('node:fs');
for (let i = 1; i <= 5; i++) {
  const r = JSON.parse(fs.readFileSync('${OUT}/seed-run-' + i + '.json', 'utf8'));
  if (r.runtime.model !== 'stub' || r.runtime.provider !== 'stub') throw new Error('keyless stub only: seed run ' + i + ' model=' + r.runtime.provider + '/' + r.runtime.model);
}
console.log('seed ok: 5 stub turns');
" || exit 1

echo "### 5 CLI compact on the manual force path (same code the alarm runs)"
${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/compact.json" || exit 1
cat "${OUT}/compact.json"
node -e "
const c = require('${OUT}/compact.json');
if (!c.compacted) throw new Error('compact must fire on 30 live entries');
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
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 100 --base "${BASE}" --json > "${OUT}/entries.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta.json" || exit 1
node -p "'entries=' + require('${OUT}/entries.json').entries.length + ' leaf=' + require('${OUT}/meta.json').leaf"

echo "### 8 buildSessionContextFromEntries over the real rows: summary before tail"
cat > "${OUT}/check.mjs" <<'EOF'
import fs from "node:fs";
import { buildSessionContextFromEntries } from "../../../packages/pi-cf/src/context.ts";
const out = process.env.OUT;
const prompt1 = process.env.PROMPT1;
const prompt2 = process.env.PROMPT2;
const rows = JSON.parse(fs.readFileSync(`${out}/entries.json`, "utf8")).entries;
const leaf = JSON.parse(fs.readFileSync(`${out}/meta.json`, "utf8")).leaf;
const runA = JSON.parse(fs.readFileSync(`${out}/tail-run-1.json`, "utf8"));
const runB = JSON.parse(fs.readFileSync(`${out}/tail-run-2.json`, "utf8"));
if (typeof leaf !== "number" || leaf <= 0) throw new Error("meta leaf must be a positive cursor");
if (leaf !== rows[rows.length - 1].cursor) throw new Error("leaf " + leaf + " must equal the last cursor");
const at = rows.map((e, i) => (e.type === "compaction" ? i : -1)).filter((i) => i >= 0);
if (at.length !== 1) throw new Error("expected exactly one compaction entry, got " + at.length);
const ci = at[0];
if (ci <= 0 || ci >= rows.length - 1) throw new Error("compaction entry must sit mid-chain, got index " + ci + " of " + rows.length);
console.log("chain ok: " + rows.length + " entries, compaction at index " + ci + " (cursor " + rows[ci].cursor + ")");
const ctx = buildSessionContextFromEntries(rows, leaf);
const first = ctx.messages[0];
if (first.role !== "compactionSummary") throw new Error("first message must be the compaction summary, got " + first.role);
if (typeof first.text !== "string" || first.text.length === 0) throw new Error("summary text must be non-empty");
console.log("summary message first: role=compactionSummary cursor=" + first.cursor + " chars=" + first.text.length);
console.log("--- summary text ---");
console.log(first.text);
console.log("--- tail ---");
const tail = ctx.messages.slice(1);
const want = [
  { role: "user", text: prompt1 },
  { role: "assistant", text: runA.result },
  { role: "user", text: prompt2 },
  { role: "assistant", text: runB.result },
];
if (tail.length !== want.length) {
  throw new Error("tail must hold exactly the two post-compact turns, got " + tail.length + ": " + JSON.stringify(tail.map((m) => m.role)));
}
for (let i = 0; i < want.length; i++) {
  if (tail[i].role !== want[i].role) throw new Error("tail[" + i + "] role " + tail[i].role + " want " + want[i].role);
  if (tail[i].text !== want[i].text) throw new Error("tail[" + i + "] text differs from the live turn");
  console.log("tail[" + i + "] " + tail[i].role + " cursor=" + tail[i].cursor + ": " + JSON.stringify(tail[i].text).slice(0, 160));
}
for (let i = 1; i < ctx.messages.length; i++) {
  if (!(ctx.messages[i].cursor > ctx.messages[i - 1].cursor)) throw new Error("messages must run in cursor order");
}
console.log("tail ok: user/assistant texts equal the live prompts/results verbatim in cursor order");
if (!Array.isArray(ctx.skipped) || ctx.skipped.length === 0) throw new Error("skipped must be non-empty");
const seen = new Set(ctx.skipped.map((s) => s.type + ":" + s.reason));
for (const t of ["toolCall", "toolResult"]) {
  if (!seen.has(t + ":unprojected")) throw new Error("skipped must list " + t + " as unprojected, got " + JSON.stringify(ctx.skipped));
}
console.log("skipped ok: " + ctx.skipped.length + " entries, toolCall/toolResult unprojected");
if (ctx.model !== null) throw new Error("keyless stub path must leave model null");
if (ctx.thinking !== "off") throw new Error("no thinking switch means thinking off, got " + ctx.thinking);
if (ctx.toolNames !== null) throw new Error("toolNames stays null (MEM-06 owns budgets)");
console.log("config ok: model null, thinking off, toolNames null");
EOF
node "${OUT}/check.mjs" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
