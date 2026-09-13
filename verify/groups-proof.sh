#!/bin/sh
# groups-proof.sh — proves bot crews end to end: create with member
# resolution (id + name + materialization), a user message fans out to every
# member (each wakes and consumes through the alarm), a member replies with
# the real send tool (fake keyed upstream) and the reply lands on the group
# channel for the other member, request-id retries dedupe per member, and a
# non-member receives nothing. Owns its worker (:8795, scratch persist).
# Usage: sh verify/groups-proof.sh
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/groups-proof/.
set -u
BASE="http://127.0.0.1:8795"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/groups-proof"
mkdir -p "${OUT}"
PORT="8795"
UP_PORT="8899"
UP_LOG="${OUT}/upstream.log"
MODELS_JSON="${ROOT}/worker/models.json"
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/groups-proof-XXXXXX")"
cd "${ROOT}"

restore() {
  mv "${OUT}/models.json.backup" "${MODELS_JSON}" 2>/dev/null
  lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
  lsof -ti :8795 | xargs kill 2>/dev/null
  return 0
}
trap restore EXIT
fail() { echo "FAIL groups-proof: $1"; exit 1; }
json_field() {
  node -e "const d=require('${1}'); const v=d${2}; if(v===undefined)process.exit(3); process.stdout.write(String(v));"
}

echo "### 1 fake upstream up (member reply via the real send tool)"
lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
sleep 1
node verify/fixtures/send-upstream.mjs "${UP_LOG}" "${UP_PORT}" "offsite-crew-${RUN_ID}" "crew-msg-${RUN_ID}" > /dev/null 2>&1 &
UP_PID=$!
sleep 1
kill -0 "${UP_PID}" 2>/dev/null || fail "fake upstream did not start"

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
" || fail "models.json patch"

echo "### 3 dev server up on ${PORT}"
(cd "${ROOT}/worker" && exec npx wrangler dev --port "${PORT}" --persist-to "${TMPBASE}/persist" --var SENDFAKE_API_KEY:send-test-key > "${OUT}/dev.log" 2>&1 & echo "$!" > "${TMPBASE}/dev.pid")
i=0
while ! curl -s -o /dev/null "${BASE}"; do
  i=$((i + 1))
  [ "${i}" -ge 90 ] && { tail -20 "${OUT}/dev.log"; fail "dev never ready"; }
  sleep 1
done

echo "### 4 fixtures: chief session + two crew sessions (one created by name)"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || fail "workspace create"
printf '%s' "${WS_JSON}" > "${OUT}/ws.json"
WS="$(json_field "${OUT}/ws.json" ".workspaceId")"
printf '%s' "seeded-body-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json > "${OUT}/seed-put.json" || fail "seed put"
${CLI} session create --ws "${WS}" --backstory "You are the Chief of Staff for ${RUN_ID}." --base "${BASE}" --json > "${OUT}/chief.json" || fail "chief session"
CHIEF="$(json_field "${OUT}/chief.json" ".sessionId")"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/am.json" || fail "account-manager session"
AM="$(json_field "${OUT}/am.json" ".sessionId")"
${CLI} model --ws "${WS}" --sid "${CHIEF}" --model sendfake/send-1 --base "${BASE}" --json > "${OUT}/model.json" || fail "model switch"

echo "### 5 create group: members by id and by materialized name"
${CLI} groups create --ws "${WS}" --name "offsite-crew-${RUN_ID}" --members "${CHIEF},${AM},scout-${RUN_ID}" --base "${BASE}" --json > "${OUT}/group.json" || fail "group create"
GID="$(json_field "${OUT}/group.json" ".group.id")"
${CLI} groups list --ws "${WS}" --base "${BASE}" --json > "${OUT}/groups-list.json" || fail "groups list"
node -e "
const d=require('${OUT}/groups-list.json');
const g=d.groups.find(g=>g.id==='${GID}');
if (!g || g.members.length !== 3) throw new Error('expected 3 members, got ' + JSON.stringify(g));
" || fail "group members"
curl -sf "${BASE}/workspaces/${WS}/sessions" -o "${OUT}/sessions.json" || fail "sessions list"
M3="$(json_field "${OUT}/sessions.json" ".sessions.find(s=>s.name==='scout-${RUN_ID}').sid")"
[ -n "${M3}" ] && [ "${M3}" != "null" ] || fail "materialized member missing"
curl -sf "${BASE}/workspaces/${WS}/sessions/${M3}/meta" -o "${OUT}/scout-meta.json" || fail "materialized member meta"
[ "$(json_field "${OUT}/scout-meta.json" ".name")" = "scout-${RUN_ID}" ] || fail "materialized member name"
echo "PASS 5 group created: chief + account-manager + materialized scout (${GID})"

echo "### 6 user message to the group fans out and wakes every member"
${CLI} groups send --ws "${WS}" --id "${GID}" --from "${CHIEF}" --body "sound-off-${RUN_ID}" --request-id "gp-6" --base "${BASE}" --json > "${OUT}/fanout.json" || fail "group send"
[ "$(json_field "${OUT}/fanout.json" ".delivered")" = "2" ] || fail "fan-out delivered != 2 (am + scout; chief is sender)"
TRIES=0
CONSUMED=0
while [ "${TRIES}" -lt 30 ] && [ "${CONSUMED}" -lt 2 ]; do
  CONSUMED=0
  for SIDX in "${AM}" "${M3}"; do
    ${CLI} entries --ws "${WS}" --sid "${SIDX}" --all --base "${BASE}" --json > "${OUT}/entries-${SIDX}.json" 2>/dev/null || true
    N="$(node -e "const d=require('${OUT}/entries-${SIDX}.json'); const es=(d.entries||[]).filter(e=>e.type==='prompt'&&String(e.body).includes('sound-off-${RUN_ID}')); process.stdout.write(String(es.length));")"
    [ "${N}" -ge 1 ] && CONSUMED=$((CONSUMED + 1))
  done
  [ "${CONSUMED}" -lt 2 ] && sleep 2
done
[ "${CONSUMED}" = "2" ] || fail "only ${CONSUMED}/2 members consumed the group message"
echo "PASS 6 fan-out: both members woke and consumed"

echo "### 7 member replies with the real send tool to the group name"
${CLI} model --ws "${WS}" --sid "${AM}" --model sendfake/send-1 --base "${BASE}" --json > "${OUT}/model-am.json" || fail "am model switch"
${CLI} run --ws "${WS}" --sid "${AM}" --prompt "report your status" --base "${BASE}" --json > "${OUT}/am-run.json" || fail "am run"
node -e "
const b = require('${OUT}/am-run.json');
const tools = (b.toolCalls || []).map((c) => c.tool);
if (!tools.includes('send')) throw new Error('expected send toolCall, got ' + tools.join(','));
console.log('tool ok: member replied via send to the group name');
" || fail "member send assertion"
${CLI} groups messages --ws "${WS}" --id "${GID}" --base "${BASE}" --json > "${OUT}/channel.json" || fail "channel list"
REPLY_N="$(node -e "const d=require('${OUT}/channel.json'); process.stdout.write(String(d.messages.filter(m=>m.from==='${AM}' && m.body.includes('crew-msg-${RUN_ID}')).length));")"
[ "${REPLY_N}" -ge 1 ] || fail "member reply missing from the group channel"
echo "PASS 7 member reply landed on the group channel"

echo "### 8 request-id retry dedupes per member"
${CLI} groups send --ws "${WS}" --id "${GID}" --from "${CHIEF}" --body "dedupe-${RUN_ID}" --request-id "gp-8" --base "${BASE}" --json > "${OUT}/fan8a.json" || fail "send 8a"
${CLI} groups send --ws "${WS}" --id "${GID}" --from "${CHIEF}" --body "dedupe-${RUN_ID}" --request-id "gp-8" --base "${BASE}" --json > "${OUT}/fan8b.json" || fail "send 8b"
${CLI} groups messages --ws "${WS}" --id "${GID}" --base "${BASE}" --json > "${OUT}/channel-8.json" || fail "channel 8"
N8="$(node -e "const d=require('${OUT}/channel-8.json'); process.stdout.write(String(d.messages.filter(m=>m.body.includes('dedupe-${RUN_ID}')).length));")"
[ "${N8}" = "2" ] || fail "expected 2 rows (one per member), got ${N8}"
echo "PASS 8 dedupe: one row per member across the retry"

echo "### 9 non-member receives nothing"
${CLI} entries --ws "${WS}" --sid "${CHIEF}" --all --base "${BASE}" --json > "${OUT}/entries-chief.json" 2>/dev/null || true
CHIEF_INBOX_N="$(node -e "
try { const d=require('${OUT}/entries-chief.json'); process.stdout.write(String((d.entries||[]).filter(e=>e.type==='prompt'&&String(e.body).includes('dedupe-${RUN_ID}')).length)); } catch { process.stdout.write('0'); }
")"
[ "${CHIEF_INBOX_N}" = "0" ] || fail "chief (the sender) received its own message"
echo "PASS 9 sender excluded from fan-out"

echo "PASS groups-proof: all scenario checks green"
