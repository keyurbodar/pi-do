#!/bin/sh
# send-tool-proof.sh — proves agent-initiated messaging end to end: a bot's
# turn calls the real `send` tool through a fake keyed upstream, the message
# persists durably, the recipient bot wakes and consumes it (delivered with
# an outcome cursor), and a send to an unknown name spawns the bot with the
# body as its persona. Uses the fake-upstream fixture pattern (temp
# models.json + provider key var) so the whole thing is deterministic
# keyless-quota-free; restores models.json and owns its server (:8796).
# Usage: sh verify/send-tool-proof.sh
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/send-tool-proof/.
set -u
BASE="http://127.0.0.1:8796"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/send-tool-proof"
mkdir -p "${OUT}"
PORT="8796"
UP_PORT="8898"
UP_LOG="${OUT}/upstream.log"
MODELS_JSON="${ROOT}/worker/models.json"
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/send-tool-proof-XXXXXX")"
cd "${ROOT}"

restore() {
  mv "${OUT}/models.json.backup" "${MODELS_JSON}" 2>/dev/null
  lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
  lsof -ti :8796 | xargs kill 2>/dev/null
  return 0
}
trap restore EXIT

fail() { echo "FAIL send-tool-proof: $1"; exit 1; }
json_field() {
  node -e "const d=require('${1}'); const v=d${2}; if(v===undefined)process.exit(3); process.stdout.write(String(v));"
}

echo "### 1 fake upstream up"
lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
sleep 1
node verify/fixtures/send-upstream.mjs "${UP_LOG}" "${UP_PORT}" "responder-${RUN_ID}" "crew-msg-${RUN_ID}" > /dev/null 2>&1 &
UP_PID=$!
sleep 1
kill -0 "${UP_PID}" 2>/dev/null || fail "fake upstream did not start on ${UP_PORT}"

echo "### 2 temp models.json gains provider sendfake"
cp "${MODELS_JSON}" "${OUT}/models.json.backup" || fail "backup models.json"
node -e "
const fs = require('node:fs');
const p = '${MODELS_JSON}';
const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
doc.providers.sendfake = {
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:${UP_PORT}/v1',
  models: [{ id: 'send-1', name: 'Send One', api: 'openai-completions', baseUrl: 'http://127.0.0.1:${UP_PORT}/v1', contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
};
fs.writeFileSync(p, JSON.stringify(doc));
console.log('models.json patched');
" || fail "models.json patch"

echo "### 3 dev server up on ${PORT} with the provider key var"
(cd "${ROOT}/worker" && exec npx wrangler dev --port "${PORT}" --persist-to "${TMPBASE}/persist" --var SENDFAKE_API_KEY:send-test-key > "${OUT}/dev.log" 2>&1 & echo "$!" > "${TMPBASE}/dev.pid")
i=0
while ! curl -s -o /dev/null "${BASE}"; do
  i=$((i + 1))
  [ "${i}" -ge 90 ] && { tail -20 "${OUT}/dev.log"; fail "dev server never became ready"; }
  sleep 1
done
echo "dev ready on ${PORT}"

echo "### 4 sender bot with a chief persona; recipient created by the tool itself"
${CLI} workspace create --base "${BASE}" --json > "${OUT}/ws.json" || fail "workspace create"
WS="$(json_field "${OUT}/ws.json" ".workspaceId")"
printf '%s' "seeded-body-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json > "${OUT}/seed-put.json" || fail "seed put"
${CLI} session create --ws "${WS}" --backstory "You are the Chief of Staff for ${RUN_ID}." --base "${BASE}" --json > "${OUT}/s1.json" || fail "sender session"
S1="$(json_field "${OUT}/s1.json" ".sessionId")"
${CLI} model --ws "${WS}" --sid "${S1}" --model sendfake/send-1 --base "${BASE}" --json > "${OUT}/model.json" || fail "model switch"
echo "WS=${WS} S1=${S1}"

echo "### 5 the chief's turn calls send mid-turn; the recipient wakes and consumes"
${CLI} run --ws "${WS}" --sid "${S1}" --prompt "staff the offsite crew" --base "${BASE}" --json > "${OUT}/run.json" || fail "chief run"
node -e "
const b = require('${OUT}/run.json');
const tools = (b.toolCalls || []).map((c) => c.tool);
if (!tools.includes('send')) throw new Error('expected a send toolCall, got ' + tools.join(','));
console.log('tool ok: send ran inside the chief turn (' + tools.join(',') + ')');
" || fail "send toolCall assertion"
[ "$(grep -c "toolResult=true" "${UP_LOG}")" -ge 1 ] || fail "upstream never saw the tool result"

echo "### 6 the message persisted durably to the spawned recipient"
BOT_NAME="responder-${RUN_ID}"
${CLI} inbox list --ws "${WS}" --sid "${S1}" --base "${BASE}" --json > "${OUT}/list.json" || fail "inbox list"
MID="$(json_field "${OUT}/list.json" ".messages.find(m=>m.body.includes('crew-msg-${RUN_ID}')).id")"
[ "${MID}" != "null" ] && [ -n "${MID}" ] || fail "crew message row missing"
BOT_SID="$(json_field "${OUT}/list.json" ".messages.find(m=>m.id==='${MID}').to")"
curl -sf "${BASE}/workspaces/${WS}/sessions/${BOT_SID}/meta" -o "${OUT}/bot-meta.json" || fail "spawned meta"
[ "$(json_field "${OUT}/bot-meta.json" ".name")" = "${BOT_NAME}" ] || fail "spawned session name"
[ "$(json_field "${OUT}/bot-meta.json" ".backstory")" = "crew-msg-${RUN_ID}" ] || fail "spawned backstory != body"

echo "### 7 the recipient woke and consumed: delivered with an outcome cursor"
TRIES=0
while [ "${TRIES}" -lt 30 ]; do
  ${CLI} inbox list --ws "${WS}" --sid "${S1}" --base "${BASE}" --json > "${OUT}/list-7.json" || fail "inbox list 7"
  DELIVERED="$(json_field "${OUT}/list-7.json" ".messages.find(m=>m.id==='${MID}').deliveredAt")"
  OC="$(json_field "${OUT}/list-7.json" ".messages.find(m=>m.id==='${MID}').outcomeCursor")"
  [ "${DELIVERED}" != "null" ] && [ "${OC}" != "null" ] && break
  TRIES=$((TRIES + 1))
  sleep 2
done
[ "${DELIVERED}" != "null" ] || fail "recipient never consumed the message"
[ "${OC}" != "null" ] || fail "consumed without an outcome cursor"
${CLI} entries --ws "${WS}" --sid "${BOT_SID}" --all --base "${BASE}" --json > "${OUT}/entries-bot.json" || fail "bot entries"
node -e "
const d = require('${OUT}/entries-bot.json');
const prompt = (d.entries||[]).filter(e=>e.type==='prompt' && e.body && String(e.body).includes('crew-msg-${RUN_ID}'));
if (prompt.length !== 1) throw new Error('expected the wake prompt to carry the message, got ' + prompt.length);
if (!(d.entries||[]).some(e=>e.type==='result')) throw new Error('recipient turn has no result entry');
console.log('wake ok: recipient consumed the message and completed a turn');
" || fail "recipient wake assertion"

echo "PASS send-tool-proof: all scenario checks green"
