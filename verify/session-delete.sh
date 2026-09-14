#!/bin/sh
# session-delete.sh — proves DELETE /workspaces/:id/sessions/:sid end to end
# on a real wrangler dev instance: the tombstoned session drops out of the
# roster, its routines and group memberships are deleted in the same
# transaction, every sid-scoped route 404s it, a queued inbox row for it is
# drained by the wake guard (delivered, never run through the model), a
# re-delete 404s, and a sibling session keeps sending and waking. Owns its
# worker (:8798, scratch persist) plus a fake upstream (:8897) so wake turns
# are observable.
# Usage: sh verify/session-delete.sh
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/session-delete/.
set -u
BASE="http://127.0.0.1:8798"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/session-delete"
mkdir -p "${OUT}"
PORT="8798"
UP_PORT="8897"
UP_LOG="${OUT}/upstream.log"
MODELS_JSON="${ROOT}/worker/models.json"
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/session-delete-XXXXXX")"
cd "${ROOT}"

restore() {
  mv "${OUT}/models.json.backup" "${MODELS_JSON}" 2>/dev/null
  lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
  lsof -ti ":${PORT}" | xargs kill 2>/dev/null
  return 0
}
trap restore EXIT
fail() { echo "FAIL session-delete: $1"; exit 1; }
json_field() {
  node -e "const d=require('${1}'); const v=d${2}; if(v===undefined)process.exit(3); process.stdout.write(String(v));"
}
http_status() {
  curl -s -o "${3}" -w '%{http_code}' -X "${1}" "${2}"
}

echo "### 1 fake upstream up (wake turns observable)"
lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
lsof -ti ":${PORT}" | xargs kill 2>/dev/null
sleep 1
node verify/fixtures/steer-upstream.mjs "${UP_LOG}" "${UP_PORT}" > /dev/null 2>&1 &
sleep 1
lsof -ti ":${UP_PORT}" > /dev/null 2>&1 || fail "fake upstream did not start"

echo "### 2 temp models.json gains provider wakefake"
cp "${MODELS_JSON}" "${OUT}/models.json.backup" || fail "backup models.json"
node -e "
const fs = require('node:fs');
const p = '${MODELS_JSON}';
const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
doc.providers.wakefake = {
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:${UP_PORT}/v1',
  models: [{ id: 'wake-1', name: 'Wake One', api: 'openai-completions', baseUrl: 'http://127.0.0.1:${UP_PORT}/v1', contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
};
fs.writeFileSync(p, JSON.stringify(doc));
" || fail "models.json patch"

echo "### 3 dev server up on ${PORT}"
(cd "${ROOT}/worker" && exec npx wrangler dev --port "${PORT}" --persist-to "${TMPBASE}/persist" --var WAKEFAKE_API_KEY:wake-test-key > "${OUT}/dev.log" 2>&1 & echo "$!" > "${TMPBASE}/dev.pid")
i=0
while ! curl -s -o /dev/null "${BASE}"; do
  i=$((i + 1))
  [ "${i}" -ge 90 ] && fail "dev never became ready on ${BASE} (see ${OUT}/dev.log)"
  sleep 1
done

echo "### 4 fixtures: workspace + sessions A B C, group over A+B, routine on B"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || fail "workspace create"
printf '%s' "${WS_JSON}" > "${OUT}/ws.json"
WS="$(json_field "${OUT}/ws.json" ".workspaceId")"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/a.json" || fail "session A"
A="$(json_field "${OUT}/a.json" ".sessionId")"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/b.json" || fail "session B"
B="$(json_field "${OUT}/b.json" ".sessionId")"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/c.json" || fail "session C"
C="$(json_field "${OUT}/c.json" ".sessionId")"
${CLI} model --ws "${WS}" --sid "${A}" --model wakefake/wake-1 --base "${BASE}" --json > "${OUT}/model-a.json" || fail "model A"
${CLI} model --ws "${WS}" --sid "${B}" --model wakefake/wake-1 --base "${BASE}" --json > "${OUT}/model-b.json" || fail "model B"
${CLI} groups create --ws "${WS}" --name "del-crew-${RUN_ID}" --members "${A},${B}" --base "${BASE}" --json > "${OUT}/group.json" || fail "group create"
GID="$(json_field "${OUT}/group.json" ".group.id")"
${CLI} routines create --ws "${WS}" --sid "${B}" --kind interval --spec 300 --prompt "tick-${RUN_ID}" --base "${BASE}" --json > "${OUT}/routine.json" || fail "routine create"
RID="$(json_field "${OUT}/routine.json" ".routine.id")"
echo "PASS 4 fixtures: ws=${WS} A=${A} B=${B} C=${C} group=${GID} routine=${RID}"

echo "### 5 B's queue held by an in-flight run; inbox row lands, then B is deleted"
# The steer upstream holds the first model call ~4s, so B's run turn keeps
# B's session queue busy while the inbox row and the DELETE land — the wake
# turn for the row is then guaranteed to run after the tombstone.
${CLI} run --ws "${WS}" --sid "${B}" --prompt "hold-${RUN_ID}" --base "${BASE}" --json > "${OUT}/b-run.json" 2>&1 &
RUN_PID=$!
i=0
while [ ! -f "${UP_LOG}" ] || [ "$(wc -l < "${UP_LOG}" | tr -d ' ')" = "0" ]; do
  i=$((i + 1))
  [ "${i}" -ge 30 ] && fail "B's run never reached the upstream"
  sleep 1
done
${CLI} inbox send --ws "${WS}" --sid "${A}" --to "${B}" --body "pre-delete-${RUN_ID}" --base "${BASE}" --json > "${OUT}/send-to-b.json" || fail "send to B"
DEL_CODE="$(http_status DELETE "${BASE}/workspaces/${WS}/sessions/${B}" "${OUT}/delete-b.json")"
[ "${DEL_CODE}" = "200" ] || fail "DELETE B returned ${DEL_CODE}: $(cat "${OUT}/delete-b.json")"
[ "$(json_field "${OUT}/delete-b.json" ".deleted")" = "${B}" ] || fail "delete body missing deleted sid"
wait "${RUN_PID}" 2>/dev/null || true
echo "PASS 5 DELETE B -> 200 {ok:true, deleted:${B}}"

echo "### 6 roster drops B"
curl -sf "${BASE}/workspaces/${WS}/sessions" -o "${OUT}/sessions-after.json" || fail "sessions list"
node -e "
const d = require('${OUT}/sessions-after.json');
const sids = d.sessions.map((s) => s.sid);
if (sids.length !== 2) throw new Error('expected 2 sessions, got ' + sids.length);
if (sids.includes('${B}')) throw new Error('deleted session still listed');
if (!sids.includes('${A}') || !sids.includes('${C}')) throw new Error('survivors missing');
" || fail "roster still shows B"
echo "PASS 6 GET /sessions lists 2 sessions, B absent"

echo "### 7 B's routine row is gone"
${CLI} routines list --ws "${WS}" --sid "${A}" --base "${BASE}" --json > "${OUT}/routines-after.json" || fail "routines list"
node -e "
const d = require('${OUT}/routines-after.json');
const hit = (d.routines || []).filter((r) => r.id === '${RID}' || r.sid === '${B}');
if (hit.length !== 0) throw new Error('routine survived: ' + JSON.stringify(hit));
" || fail "routine row survived the delete"
echo "PASS 7 routine ${RID} deleted with the session"

echo "### 8 B's group membership is gone"
${CLI} groups list --ws "${WS}" --base "${BASE}" --json > "${OUT}/groups-after.json" || fail "groups list"
node -e "
const d = require('${OUT}/groups-after.json');
const g = (d.groups || []).find((g) => g.id === '${GID}');
if (!g) throw new Error('group vanished');
if (g.members.length !== 1 || g.members[0] !== '${A}') throw new Error('members: ' + JSON.stringify(g.members));
" || fail "membership survived the delete"
echo "PASS 8 group ${GID} down to 1 member (A)"

echo "### 9 sid-scoped routes 404 for B"
CODE="$(http_status GET "${BASE}/workspaces/${WS}/sessions/${B}/entries" "${OUT}/entries-b.json")"
[ "${CODE}" = "404" ] || fail "GET entries on deleted B returned ${CODE}"
CODE="$(http_status POST "${BASE}/workspaces/${WS}/sessions/${B}/inbox" "${OUT}/inbox-b.json")"
[ "${CODE}" = "404" ] || fail "POST inbox on deleted B returned ${CODE}"
CODE="$(http_status POST "${BASE}/workspaces/${WS}/sessions/${B}/run" "${OUT}/run-b.json")"
[ "${CODE}" = "404" ] || fail "POST run on deleted B returned ${CODE}"
echo "PASS 9 entries/inbox/run on deleted B all 404"

echo "### 10 re-delete 404s"
CODE="$(http_status DELETE "${BASE}/workspaces/${WS}/sessions/${B}" "${OUT}/delete-b-again.json")"
[ "${CODE}" = "404" ] || fail "re-DELETE B returned ${CODE}"
echo "PASS 10 second DELETE B -> 404"

echo "### 11 the queued inbox row for B is drained, never woken"
# The wake guard marks the row delivered with no outcome cursor — a real
# consumption would carry the turn's head cursor — and no upstream call
# ever carries the pre-delete body.
i=0
DRAINED=""
while [ "${i}" -lt 30 ]; do
  ${CLI} inbox list --ws "${WS}" --sid "${A}" --base "${BASE}" --json > "${OUT}/inbox-a.json" 2>/dev/null || true
  DRAINED="$(node -e "
const d = require('${OUT}/inbox-a.json');
const m = (d.messages || []).find((m) => m.to === '${B}' && String(m.body).includes('pre-delete-${RUN_ID}'));
if (m && m.deliveredAt !== null && m.outcomeCursor === null) process.stdout.write('yes');
" 2>/dev/null)"
  [ "${DRAINED}" = "yes" ] && break
  i=$((i + 1))
  sleep 1
done
[ "${DRAINED}" = "yes" ] || fail "inbox row for deleted B never drained (see ${OUT}/inbox-a.json)"
# B's run turn is exactly two upstream calls (tool call, then the tool-result
# follow-up). A wake turn for the queued row would add a third.
UP_N="$(wc -l < "${UP_LOG}" | tr -d ' ')"
[ "${UP_N}" = "2" ] || fail "deleted B's wake turn reached the model (upstream hits: ${UP_N}, want 2)"
echo "PASS 11 queued row drained by the wake guard (delivered, no model call)"

echo "### 12 bot A unaffected: send + wake still works"
UP_BEFORE="$(wc -l < "${UP_LOG}" | tr -d ' ')"
${CLI} inbox send --ws "${WS}" --sid "${C}" --to "${A}" --body "post-delete-${RUN_ID}" --wait --timeout 60 --base "${BASE}" --json > "${OUT}/wake-a.json" || fail "send to A"
node -e "
const d = require('${OUT}/wake-a.json');
if (!d.message || d.message.outcomeCursor === null || d.message.outcomeCursor === undefined) {
  throw new Error('A never consumed the message: ' + JSON.stringify(d));
}
" || fail "A's wake turn did not consume the message"
UP_AFTER="$(wc -l < "${UP_LOG}" | tr -d ' ')"
[ "${UP_AFTER}" -gt "${UP_BEFORE}" ] || fail "A's wake turn never reached the upstream (${UP_BEFORE} -> ${UP_AFTER})"
echo "PASS 12 A woke and consumed C's message after B's delete"

echo "PASS session-delete: all scenario checks green"
