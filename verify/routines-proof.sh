#!/bin/sh
# routines-proof.sh — proves scheduled durable turns end to end on the real
# server: a once routine fires through the alarm mux into the normal turn
# pipeline, fires exactly once under extra alarm ticks and across a server
# restart, an interval routine across downtime consumes exactly ONE overdue
# run (no catch-up burst), expiry deactivates before firing, the 51st active
# routine is rejected with a hint, and two near-simultaneous alarm pokes
# produce one fire for one due row. Weekly and monthly scheduling are covered
# by worker/test/routines.test.mjs (a weekly e2e would need a 7-day clock).
# Owns its worker: boots a private `wrangler dev` on the BASE port with a
# scratch --persist-to dir (default :8795, never the shared :8787) so it can
# kill and reboot it for the restart scenarios. Stays out of fast-battery's
# tier for the same reason sigkill-e2e does.
# Usage: sh verify/routines-proof.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/routines-proof/.
set -u
BASE="${1:-http://127.0.0.1:8795}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/routines-proof"
mkdir -p "${OUT}"
PORT="$(printf '%s' "${BASE}" | sed -n 's/^.*:\([0-9][0-9]*\)\/*$/\1/p')"
if [ -z "${PORT}" ]; then PORT="8795"; fi
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/routines-proof-XXXXXX")"
PIDFILE="${TMPBASE}/dev.pid"
cd "${ROOT}"

start_dev() {
  tag="$1"
  (cd "${ROOT}/worker" && exec >>"${OUT}/${tag}.log" 2>&1 </dev/null && exec npx wrangler dev --port "${PORT}" --persist-to "${TMPBASE}/persist" & echo "$!" >"${PIDFILE}")
  i=0
  while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 90 ]; then
      echo "dev never became ready on ${BASE} (see ${OUT}/${tag}.log)"
      return 1
    fi
    sleep 1
  done
  echo "dev ready on ${BASE} (${tag})"
}

rkill_tree() {
  for c in $(pgrep -P "$1" 2>/dev/null); do rkill_tree "$c"; done
  kill -KILL "$1" 2>/dev/null || true
}

kill_dev() {
  if [ -f "${PIDFILE}" ]; then rkill_tree "$(cat "${PIDFILE}")"; fi
  i=0
  while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 30 ]; then echo "port ${PORT} still serves traffic; refusing to continue"; return 1; fi
    sleep 1
  done
}

cleanup() { kill_dev >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL routines-proof: $1"; exit 1; }

json_field() {
  node -e "const d=require('${1}'); const v=d${2}; if(v===undefined)process.exit(3); process.stdout.write(String(v));"
}

# prompt_entries ROUTINE_ID FILE -> count of prompt entries attributable to the routine
prompt_entries() {
  node -e "const d=require('${2}'); const es=(d.entries||[]).filter((e)=>e.type==='prompt'&&e.body&&e.body.includes('${1}')); process.stdout.write(String(es.length));"
}

result_entries() {
  node -e "const d=require('${1}'); const es=(d.entries||[]).filter((e)=>e.type==='result'); process.stdout.write(String(es.length));"
}

wait_routine_fired() {
  rid="$1" tries="$2" tag="$3"
  i=0
  while [ "${i}" -lt "${tries}" ]; do
    ${CLI} entries --ws "${WS}" --sid "${SID}" --all --base "${BASE}" --json > "${OUT}/entries-${tag}.json" 2>/dev/null || true
    if [ "$(prompt_entries "${rid}" "${OUT}/entries-${tag}.json")" = "1" ] && [ "$(result_entries "${OUT}/entries-${tag}.json")" -ge 1 ]; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  return 1
}

echo "### boot + fixtures"
start_dev "boot" || exit 1
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || fail "workspace create"
printf '%s' "${WS_JSON}" > "${OUT}/ws.json"
WS="$(json_field "${OUT}/ws.json" ".workspaceId")"
printf '%s' "seeded-body-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json > "${OUT}/seed-put.json" || fail "seed put"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/s1.json" || fail "session create"
SID="$(json_field "${OUT}/s1.json" ".sessionId")"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/s2.json" || fail "helper session create"
SID2="$(json_field "${OUT}/s2.json" ".sessionId")"
echo "WS=${WS} SID=${SID}"

echo "### 1 once routine fires ~5s out: prompt entry plus result entry land in window"
ONCE_AT="$(node -p "new Date(Date.now()+4000).toISOString()")"
${CLI} routines create --ws "${WS}" --sid "${SID}" --kind once --spec "${ONCE_AT}" --prompt "read seed.txt" --request-id "proof-1" --base "${BASE}" --json > "${OUT}/r1.json" || fail "create once"
R1="$(json_field "${OUT}/r1.json" ".routine.id")"
if wait_routine_fired "${R1}" 20 "once"; then
  echo "PASS 1 once fired within window (routine ${R1})"
else
  fail "once routine ${R1} did not fire within 40s"
fi

echo "### 2 exactly-once: run_count 1, one prompt entry, survives a forced extra alarm tick"
${CLI} routines list --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/list-1.json" || fail "list"
[ "$(json_field "${OUT}/list-1.json" ".routines.find(r=>r.id==='${R1}').runCount")" = "1" ] || fail "run_count != 1 after first fire"
${CLI} routines create --ws "${WS}" --sid "${SID2}" --kind once --spec "$(node -p "new Date(Date.now()-1000).toISOString()")" --prompt "tick helper" --base "${BASE}" --json > "${OUT}/helper-1.json" || fail "helper create"
sleep 5
${CLI} routines list --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/list-2.json" || fail "list 2"
${CLI} entries --ws "${WS}" --sid "${SID}" --all --base "${BASE}" --json > "${OUT}/entries-exact.json" || fail "entries"
[ "$(json_field "${OUT}/list-2.json" ".routines.find(r=>r.id==='${R1}').runCount")" = "1" ] || fail "run_count moved after extra tick"
[ "$(prompt_entries "${R1}" "${OUT}/entries-exact.json")" = "1" ] || fail "prompt entry count != 1 after extra tick"
echo "PASS 2 exactly-once under forced extra tick (routine ${R1})"

echo "### 3 restart mid-wait: kill the recorded server PID, reboot, routine still fires exactly once"
${CLI} routines create --ws "${WS}" --sid "${SID}" --kind once --spec "$(node -p "new Date(Date.now()+8000).toISOString()")" --prompt "read seed.txt" --request-id "proof-3" --base "${BASE}" --json > "${OUT}/r3.json" || fail "create restart routine"
R3="$(json_field "${OUT}/r3.json" ".routine.id")"
kill_dev || fail "kill dev"
sleep 10
start_dev "restart" || fail "restart dev"
if wait_routine_fired "${R3}" 20 "restart"; then
  ${CLI} routines list --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/list-3.json" || fail "list 3"
  [ "$(json_field "${OUT}/list-3.json" ".routines.find(r=>r.id==='${R3}').runCount")" = "1" ] || fail "restart run_count != 1"
  echo "PASS 3 restart mid-wait fires exactly once (routine ${R3})"
else
  fail "restart routine ${R3} never fired"
fi

echo "### 4 no catch-up burst: interval routine across ~2.5 periods of downtime consumes exactly ONE overdue run"
${CLI} routines create --ws "${WS}" --sid "${SID}" --kind interval --spec "60" --prompt "read seed.txt" --request-id "proof-4" --base "${BASE}" --json > "${OUT}/r4.json" || fail "create interval"
R4="$(json_field "${OUT}/r4.json" ".routine.id")"
kill_dev || fail "kill dev for downtime"
sleep 145
start_dev "reboot" || fail "reboot dev"
i=0
while [ "${i}" -lt 20 ]; do
  ${CLI} routines list --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/list-4.json" 2>/dev/null || true
  RC="$(json_field "${OUT}/list-4.json" ".routines.find(r=>r.id==='${R4}').runCount" 2>/dev/null || echo 0)"
  [ "${RC}" = "1" ] && break
  i=$((i + 1))
  sleep 2
done
[ "${RC}" = "1" ] || fail "interval run_count is ${RC}, want exactly 1 after downtime"
NEXT="$(json_field "${OUT}/list-4.json" ".routines.find(r=>r.id==='${R4}').nextRunAt")"
node -e "
const t = Date.parse('${NEXT}');
const dt = t - Date.now();
if (!(dt > 45000 && dt < 75000)) { console.error('next run ' + '${NEXT}' + ' is not one interval from now'); process.exit(1); }
" || fail "next_run_at is not one interval from now (catch-up burst shape)"
sleep 6
${CLI} routines list --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/list-4b.json" || fail "list 4b"
[ "$(json_field "${OUT}/list-4b.json" ".routines.find(r=>r.id==='${R4}').runCount")" = "1" ] || fail "interval fired twice within one interval"
echo "PASS 4 single overdue consume, next from now (routine ${R4})"
${CLI} routines delete --ws "${WS}" --sid "${SID}" --id "${R4}" --base "${BASE}" --json > "${OUT}/del-4.json" || fail "delete interval"

echo "### 5 expiry stops firing"
${CLI} routines create --ws "${WS}" --sid "${SID}" --kind once --spec "$(node -p "new Date(Date.now()+6000).toISOString()")" --prompt "should never run" --expire-at "$(node -p "new Date(Date.now()-1000).toISOString()")" --base "${BASE}" --json > "${OUT}/r5.json" || fail "create expired"
R5="$(json_field "${OUT}/r5.json" ".routine.id")"
sleep 14
${CLI} routines list --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/list-5.json" || fail "list 5"
[ "$(json_field "${OUT}/list-5.json" ".routines.find(r=>r.id==='${R5}').active")" = "false" ] || fail "expired routine still active"
[ "$(json_field "${OUT}/list-5.json" ".routines.find(r=>r.id==='${R5}').runCount")" = "0" ] || fail "expired routine fired"
${CLI} entries --ws "${WS}" --sid "${SID}" --all --base "${BASE}" --json > "${OUT}/entries-5.json" || fail "entries 5"
[ "$(prompt_entries "${R5}" "${OUT}/entries-5.json")" = "0" ] || fail "expired routine produced a prompt entry"
echo "PASS 5 expiry deactivates before firing, row kept (routine ${R5})"

echo "### 6 51st active routine rejected with hint"
S3_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || fail "session 3"
printf '%s' "${S3_JSON}" > "${OUT}/s3.json"
SID3="$(json_field "${OUT}/s3.json" ".sessionId")"
FAR="$(node -p "new Date(Date.now()+86400000).toISOString()")"
i=1
while [ "${i}" -le 50 ]; do
  ${CLI} routines create --ws "${WS}" --sid "${SID3}" --kind once --spec "${FAR}" --prompt "cap ${i}" --base "${BASE}" --json > "${OUT}/cap-${i}.json" 2>/dev/null || fail "create ${i} of 50 failed early"
  i=$((i + 1))
done
if ${CLI} routines create --ws "${WS}" --sid "${SID3}" --kind once --spec "${FAR}" --prompt "one too many" --base "${BASE}" --json > "${OUT}/cap-51.json" 2>"${OUT}/cap-51.err"; then
  fail "51st create unexpectedly succeeded"
fi
node -e "const d=require('${OUT}/cap-51.json'); if(d.error!=='too many active routines'||!/delete one/.test(d.hint||'')) { console.error(JSON.stringify(d)); process.exit(1); }" || fail "51st create error/hint shape"
echo "PASS 6 51st active rejected with {error, hint}"

echo "### 7 claims race: two near-simultaneous alarm pokes, one fire"
${CLI} workspace create --base "${BASE}" --json > "${OUT}/ws7.json" || fail "workspace 7"
WS7="$(json_field "${OUT}/ws7.json" ".workspaceId")"
${CLI} session create --ws "${WS7}" --base "${BASE}" --json > "${OUT}/s7.json" || fail "session 7"
SID="$(json_field "${OUT}/s7.json" ".sessionId")"
printf '%s' "seeded-body-${RUN_ID}" | ${CLI} files put --ws "${WS7}" --path "seed.txt" --base "${BASE}" --json > "${OUT}/seed-7.json" || fail "seed 7"
${CLI} session create --ws "${WS7}" --base "${BASE}" --json > "${OUT}/s7b.json" || fail "helper session 7"
SID2="$(json_field "${OUT}/s7b.json" ".sessionId")"
${CLI} routines create --ws "${WS7}" --sid "${SID}" --kind once --spec "$(node -p "new Date(Date.now()+3000).toISOString()")" --prompt "read seed.txt" --request-id "proof-7" --base "${BASE}" --json > "${OUT}/r7.json" || fail "create race routine"
R7="$(json_field "${OUT}/r7.json" ".routine.id")"
NOW_ISO="$(node -p "new Date(Date.now()-1000).toISOString()")"
${CLI} routines create --ws "${WS7}" --sid "${SID2}" --kind once --spec "${NOW_ISO}" --prompt "poke 1" --base "${BASE}" --json > "${OUT}/poke-1.json" || fail "poke 1"
${CLI} routines create --ws "${WS7}" --sid "${SID2}" --kind once --spec "${NOW_ISO}" --prompt "poke 2" --base "${BASE}" --json > "${OUT}/poke-2.json" || fail "poke 2"
sleep 12
${CLI} routines list --ws "${WS7}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/list-7.json" || fail "list 7"
[ "$(json_field "${OUT}/list-7.json" ".routines.find(r=>r.id==='${R7}').runCount")" = "1" ] || fail "race run_count != 1"
${CLI} entries --ws "${WS7}" --sid "${SID}" --all --base "${BASE}" --json > "${OUT}/entries-7.json" || fail "entries 7"
[ "$(prompt_entries "${R7}" "${OUT}/entries-7.json")" = "1" ] || fail "race prompt entries != 1"
echo "PASS 7 two pokes produced one fire (routine ${R7})"

echo "PASS routines-proof: all 7 scenario checks green"
