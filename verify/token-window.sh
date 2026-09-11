#!/bin/sh
# token-window.sh — proves MEM-06 token cap over the real path:
# mint a session, seed past the compact floor (a stub turn persists 6
# entries: prompt, 2x toolCall/toolResult, result), run the CLI compact down
# the manual force path, append two stub runs with distinct prompts, fetch
# the rows plus the meta leaf, build the full SessionContext, then cap it at
# a small budget (summary tokens plus the last two tail messages) and assert
# oldest-first whole-message drops with the compactionSummary intact: the
# summary stays first with verbatim text, dropped counts every removed
# message, kept cursors run strictly increasing, the kept estimate fits the
# budget, and truncated/dropped stay loud; a second cap below the summary
# size must keep the summary alone with truncated still set.
# Keyless stub only: every run must report runtime provider/model stub/stub.
# Usage: sh verify/token-window.sh [BASE]. With no BASE the script starts its
# own wrangler dev on an isolated port and stops it on exit; with a BASE it
# reuses that server.
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/token-window/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/token-window"
mkdir -p "${OUT}"
export OUT PROMPT1 PROMPT2
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
PROMPT1="tail prompt alpha ${RUN_ID}"
PROMPT2="tail prompt beta ${RUN_ID}"
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi' EXIT INT TERM
{
if [ -z "${BASE}" ]; then
PORT="8791"
while [ "${PORT}" -le 8800 ] && curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
echo "port ${PORT} busy, trying next"
PORT=$((PORT + 1))
done
if [ "${PORT}" -gt 8800 ]; then echo "no free isolated port 8791-8800"; exit 1; fi
BASE="http://127.0.0.1:${PORT}"
echo "### 0 start wrangler dev on isolated port ${PORT}"
(cd worker && exec npx wrangler dev --port "${PORT}" --persist-to "${OUT}/persist" > "${OUT}/wrangler.log" 2>&1) &
echo "$!" > "${OUT}/wrangler.pid"
I=0
while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
I=$((I + 1))
if [ "${I}" -ge 90 ]; then echo "wrangler dev never came up; see ${OUT}/wrangler.log"; exit 1; fi
sleep 2
done
echo "dev up at ${BASE} pid=$(cat "${OUT}/wrangler.pid")"
fi

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
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 100 --base "${BASE}" --json > "${OUT}/entries.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta.json" || exit 1
node -p "'entries=' + require('${OUT}/entries.json').entries.length + ' leaf=' + require('${OUT}/meta.json').leaf"

echo "### 8 capSessionContext over the real rows: oldest-first drops, summary intact"
cat > "${OUT}/check.mjs" <<'EOF'
import fs from "node:fs";
import { buildSessionContextFromEntries, capSessionContext, estimateTokens } from "../../../packages/pi-cf/src/agent/context.ts";
const out = process.env.OUT;
const rows = JSON.parse(fs.readFileSync(`${out}/entries.json`, "utf8")).entries;
const leaf = JSON.parse(fs.readFileSync(`${out}/meta.json`, "utf8")).leaf;
if (typeof leaf !== "number" || leaf <= 0) throw new Error("meta leaf must be a positive cursor");
if (leaf !== rows[rows.length - 1].cursor) throw new Error("leaf " + leaf + " must equal the last cursor");
const full = buildSessionContextFromEntries(rows, leaf);
if (full.truncated !== false || full.dropped !== 0) throw new Error("full context must be untruncated");
const first = full.messages[0];
if (first.role !== "compactionSummary") throw new Error("first message must be the compaction summary, got " + first.role);
if (typeof first.text !== "string" || first.text.length === 0) throw new Error("summary text must be non-empty");
const summaryTokens = estimateTokens(first.text);
if (summaryTokens <= 1) throw new Error("summary must span more than one token");
const fullTokens = full.messages.reduce((sum, m) => sum + estimateTokens(m.text), 0);
console.log("full ok: " + full.messages.length + " messages, " + fullTokens + " tokens, summary " + summaryTokens + " tokens");
const tail = full.messages.slice(1);
if (tail.length < 2) throw new Error("need at least two tail messages to cap against");
const budget = summaryTokens + estimateTokens(tail[tail.length - 1].text) + estimateTokens(tail[tail.length - 2].text);
if (budget >= fullTokens) throw new Error("small budget must force drops");
const before = full.messages.length;
const capped = capSessionContext(full, budget);
if (full.messages.length !== before) throw new Error("cap must not mutate the input context");
if (capped.messages[0].role !== "compactionSummary" || capped.messages[0].text !== first.text) {
  throw new Error("summary must stay first with verbatim text");
}
if (capped.truncated !== true) throw new Error("truncated must be loud, got " + capped.truncated);
if (!(capped.dropped > 0)) throw new Error("dropped must be positive, got " + capped.dropped);
if (capped.messages.length + capped.dropped !== full.messages.length) {
  throw new Error("dropped must count every removed whole message");
}
for (const m of capped.messages.slice(1)) {
  if (m.role === "compactionSummary") throw new Error("exactly one summary survives the cap");
}
let j = 0;
for (const m of capped.messages) {
  while (j < full.messages.length && full.messages[j].cursor !== m.cursor) j++;
  if (j >= full.messages.length) throw new Error("kept cursor " + m.cursor + " not in the full context");
  j++;
}
for (let i = 1; i < capped.messages.length; i++) {
  if (!(capped.messages[i].cursor > capped.messages[i - 1].cursor)) throw new Error("kept cursors must run strictly increasing");
}
const keptTail = capped.messages.slice(1);
const wantKept = tail.slice(tail.length - keptTail.length).map((m) => m.cursor);
const keptCursors = keptTail.map((m) => m.cursor);
if (JSON.stringify(keptCursors) !== JSON.stringify(wantKept)) {
  throw new Error("drops must be the oldest non-summary messages in order");
}
const droppedCursors = full.messages.slice(1, 1 + capped.dropped).map((m) => m.cursor);
const keptTokens = capped.messages.reduce((sum, m) => sum + estimateTokens(m.text), 0);
if (keptTokens > budget) throw new Error("kept estimate " + keptTokens + " must fit budget " + budget);
console.log("capped ok: budget=" + budget + " kept=" + capped.messages.length + " dropped=" + capped.dropped + " truncated=" + capped.truncated);
console.log("kept cursors: " + capped.messages.map((m) => m.cursor).join(","));
console.log("dropped cursors: " + droppedCursors.join(","));
const tiny = summaryTokens - 1;
const alone = capSessionContext(full, tiny);
if (alone.messages.length !== 1 || alone.messages[0].role !== "compactionSummary" || alone.messages[0].text !== first.text) {
  throw new Error("below-summary budget must keep the summary alone");
}
if (alone.truncated !== true) throw new Error("summary-alone must still report truncated");
if (alone.dropped !== full.messages.length - 1) throw new Error("summary-alone dropped must count every non-summary message");
console.log("summary-alone ok: budget=" + tiny + " (< summary " + summaryTokens + ") truncated=" + alone.truncated + " dropped=" + alone.dropped);
EOF
node "${OUT}/check.mjs" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
