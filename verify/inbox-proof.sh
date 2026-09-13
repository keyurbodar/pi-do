#!/bin/sh
# inbox-proof.sh — proves durable peer messaging end to end on the real
# server: a send persists before any wake, an idle recipient wakes through
# the alarm into a normal turn (prompt entry carries inboxIds and the message
# bodies), request-id retries dedupe, a server death between send and wake
# still delivers exactly once, multi-message sends arrive in order, thread
# rows list as a channel, and an unknown recipient materializes a session.
# Owns its worker: boots a private `wrangler dev` on the BASE port with a
# scratch --persist-to dir (default :8795, never the shared :8787) so it can
# kill and reboot it for the restart scenario.
# Usage: sh verify/inbox-proof.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/inbox-proof/.
set -u
BASE="${1:-http://127.0.0.1:8795}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/inbox-proof"
mkdir -p "${OUT}"
PORT="$(printf '%s' "${BASE}" | sed -n 's/^.*:\([0-9][0-9]*\)\/*$/\1/p')"
if [ -z "${PORT}" ]; then PORT="8795"; fi
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/inbox-proof-XXXXXX")"
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

fail() { echo "FAIL inbox-proof: $1"; exit 1; }

json_field() {
  node -e "const d=require('${1}'); const v=d${2}; if(v===undefined)process.exit(3); process.stdout.write(String(v));"
}

inbox_entries() {
  node -e "const d=require('${1}'); const es=(d.entries||[]).filter((e)=>{if(e.type!=='prompt')return false; const b=typeof e.body==='string'?JSON.parse(e.body):e.body; return b&&b.inboxIds&&b.inboxIds.includes('${2}');}); process.stdout.write(String(es.length));"
}

body_in_prompt() {
  node -e "const d=require('${1}'); const es=(d.entries||[]).filter((e)=>{if(e.type!=='prompt')return false; const b=typeof e.body==='string'?JSON.parse(e.body):e.body; return b&&typeof b.prompt==='string'&&b.prompt.includes(${2});}); process.stdout.write(String(es.length));"
}

# wait_delivered MSG_JSON_FILE SID_TAG -> polls the recipient session's entries
# until a prompt entry carries the message's inboxId and a result entry landed.
wait_delivered() {
  msgfile="$1" tag="$2" tries="${3:-25}"
  MID="$(json_field "${msgfile}" ".message.id")"
  TSID="$(json_field "${msgfile}" ".message.to")"
  i=0
  while [ "${i}" -lt "${tries}" ]; do
    ${CLI} entries --ws "${WS}" --sid "${TSID}" --all --base "${BASE}" --json > "${OUT}/entries-${tag}.json" 2>/dev/null || true
    if [ "$(inbox_entries "${OUT}/entries-${tag}.json" "${MID}")" -ge 1 ] && [ "$(result_entries "${OUT}/entries-${tag}.json")" -ge 1 ]; then
      echo "${TSID}"
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  return 1
}

result_entries() {
  node -e "const d=require('${1}'); const es=(d.entries||[]).filter((e)=>e.type==='result'); process.stdout.write(String(es.length));"
}

echo "### boot + fixtures"
start_dev "boot" || exit 1
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || fail "workspace create"
printf '%s' "${WS_JSON}" > "${OUT}/ws.json"
WS="$(json_field "${OUT}/ws.json" ".workspaceId")"
printf '%s' "seeded-body-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json > "${OUT}/seed-put.json" || fail "seed put"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/s1.json" || fail "sender session"
S1="$(json_field "${OUT}/s1.json" ".sessionId")"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/s2.json" || fail "recipient session"
S2="$(json_field "${OUT}/s2.json" ".sessionId")"
echo "WS=${WS} S1=${S1} S2=${S2}"

echo "### 1 send persists immediately: the row is readable right after the send"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S2}" --body "wake-msg-${RUN_ID}" --request-id "proof-1" --base "${BASE}" --json > "${OUT}/m1.json" || fail "send m1"
M1="$(json_field "${OUT}/m1.json" ".message.id")"
${CLI} inbox list --ws "${WS}" --sid "${S2}" --base "${BASE}" --json > "${OUT}/list-1.json" || fail "list"
[ "$(json_field "${OUT}/list-1.json" ".messages.find(m=>m.id==='${M1}').body")" = "wake-msg-${RUN_ID}" ] || fail "m1 row not readable after the send"
echo "PASS 1 send persisted before wake (message ${M1}; delivery may win the race, persistence is the property)"

echo "### 2 idle wake: --wait long-poll returns the outcome cursor; the consuming turn carries inboxIds plus the body"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S2}" --body "ack-msg-${RUN_ID}" --request-id "proof-2" --wait --timeout 60 --base "${BASE}" --json > "${OUT}/m2.json" || fail "send m2 with wait"
M2="$(json_field "${OUT}/m2.json" ".message.id")"
[ "$(json_field "${OUT}/m2.json" ".message.deliveredAt")" != "null" ] || fail "wait returned before delivery"
[ "$(json_field "${OUT}/m2.json" ".message.outcomeCursor")" != "null" ] || fail "wait returned without an outcome cursor"
wait_delivered "${OUT}/m2.json" "m2" || fail "m2 never landed in a consuming turn"
[ "$(inbox_entries "${OUT}/entries-m2.json" "${M2}")" = "1" ] || fail "m2 prompt entry missing"
[ "$(body_in_prompt "${OUT}/entries-m2.json" "'ack-msg-${RUN_ID}'")" -ge 1 ] || fail "message body missing from the consuming prompt"
${CLI} inbox list --ws "${WS}" --sid "${S2}" --base "${BASE}" --json > "${OUT}/list-2.json" || fail "list 2"
[ "$(json_field "${OUT}/list-2.json" ".messages.find(m=>m.id==='${M2}').deliveredAt")" != "null" ] || fail "m2 not marked delivered after the turn"
echo "PASS 2 idle wake delivered with ack (message ${M2})"

echo "### 3 exactly-once: the same request id returns the original row"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S2}" --body "dedupe-${RUN_ID}" --request-id "proof-3" --base "${BASE}" --json > "${OUT}/m3a.json" || fail "send m3a"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S2}" --body "dedupe-${RUN_ID}" --request-id "proof-3" --base "${BASE}" --json > "${OUT}/m3b.json" || fail "send m3b retry"
[ "$(json_field "${OUT}/m3a.json" ".message.id")" = "$(json_field "${OUT}/m3b.json" ".message.id")" ] || fail "request id retry produced a second message"
${CLI} inbox list --ws "${WS}" --sid "${S2}" --base "${BASE}" --json > "${OUT}/list-3.json" || fail "list 3"
N3="$(node -e "const d=require('${OUT}/list-3.json'); process.stdout.write(String(d.messages.filter(m=>m.requestId==='proof-3').length));")"
[ "${N3}" = "1" ] || fail "expected 1 row for proof-3, got ${N3}"
echo "PASS 3 request id deduped to one row"

echo "### 4 restart between send and wake still delivers exactly once"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/s3.json" || fail "restart recipient session"
S3="$(json_field "${OUT}/s3.json" ".sessionId")"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S3}" --body "survive-restart-${RUN_ID}" --request-id "proof-4" --base "${BASE}" --json > "${OUT}/m4.json" || fail "send m4"
kill_dev || fail "server did not stop"
start_dev "reboot" || fail "server did not come back"
wait_delivered "${OUT}/m4.json" "m4" 30 || fail "m4 never delivered after restart"
${CLI} entries --ws "${WS}" --sid "${S3}" --all --base "${BASE}" --json > "${OUT}/entries-m4-again.json" || fail "entries re-read"
[ "$(inbox_entries "${OUT}/entries-m4-again.json" "$(json_field "${OUT}/m4.json" ".message.id")")" = "1" ] || fail "m4 delivered more than once across restart"
echo "PASS 4 restart delivered exactly once (message $(json_field "${OUT}/m4.json" ".message.id"))"

echo "### 5 two messages to one recipient both arrive, in send order"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S2}" --body "order-first-${RUN_ID}" --request-id "proof-5a" --base "${BASE}" --json > "${OUT}/m5a.json" || fail "send m5a"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S2}" --body "order-second-${RUN_ID}" --request-id "proof-5b" --base "${BASE}" --json > "${OUT}/m5b.json" || fail "send m5b"
wait_delivered "${OUT}/m5b.json" "m5b" || fail "m5b never landed"
${CLI} entries --ws "${WS}" --sid "${S2}" --all --base "${BASE}" --json > "${OUT}/entries-m5.json" || fail "entries 5"
[ "$(body_in_prompt "${OUT}/entries-m5.json" "'order-first-${RUN_ID}'")" -ge 1 ] || fail "first message missing"
[ "$(body_in_prompt "${OUT}/entries-m5.json" "'order-second-${RUN_ID}'")" -ge 1 ] || fail "second message missing"
FIRST_AT="$(node -e "const d=require('${OUT}/entries-m5.json'); const es=d.entries.filter(e=>e.type==='prompt'&&e.body&&typeof e.body.prompt==='string'); const i=es.findIndex(e=>e.body.prompt.includes('order-first-${RUN_ID}')); const j=es.findIndex(e=>e.body.prompt.includes('order-second-${RUN_ID}')); process.stdout.write(String(i<=j?'1':'0')+' '+es.length);")"
[ "$(printf '%s' "${FIRST_AT}" | cut -d' ' -f1)" = "1" ] || fail "messages arrived out of order"
echo "PASS 5 both messages arrived in order"

echo "### 6 thread rows list as a channel"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${S2}" --body "chan-a-${RUN_ID}" --thread "offsite-${RUN_ID}" --request-id "proof-6a" --base "${BASE}" --json > "${OUT}/m6a.json" || fail "send m6a"
${CLI} inbox send --ws "${WS}" --sid "${S2}" --to "${S1}" --body "chan-b-${RUN_ID}" --thread "offsite-${RUN_ID}" --request-id "proof-6b" --base "${BASE}" --json > "${OUT}/m6b.json" || fail "send m6b"
curl -sf "${BASE}/workspaces/${WS}/sessions/${S1}/inbox?thread=offsite-${RUN_ID}" -o "${OUT}/thread-6.json" || fail "thread list"
N6="$(node -e "const d=require('${OUT}/thread-6.json'); process.stdout.write(String(d.messages.filter(m=>m.body.includes('${RUN_ID}')).length));")"
[ "${N6}" = "2" ] || fail "expected 2 thread rows, got ${N6}"
echo "PASS 6 thread channel lists both directions"

echo "### 7 spawn-by-message: an unknown recipient materializes and receives"
BOT_NAME="fresh-bot-${RUN_ID}"
${CLI} inbox send --ws "${WS}" --sid "${S1}" --to "${BOT_NAME}" --body "hello crew-${RUN_ID}" --request-id "proof-7" --wait --timeout 60 --base "${BASE}" --json > "${OUT}/m7.json" || fail "send m7"
BOT_SID="$(json_field "${OUT}/m7.json" ".message.to")"
curl -sf "${BASE}/workspaces/${WS}/sessions/${BOT_SID}/meta" -o "${OUT}/meta-7.json" || fail "spawned session meta"
[ "$(json_field "${OUT}/meta-7.json" ".name")" = "${BOT_NAME}" ] || fail "spawned session is not named ${BOT_NAME}"
wait_delivered "${OUT}/m7.json" "m7" || fail "m7 never landed in the spawned session"
echo "PASS 7 spawned session ${BOT_NAME} (${BOT_SID}) received the message"

echo "PASS inbox-proof: all 7 scenario checks green"
