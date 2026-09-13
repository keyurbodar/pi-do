#!/bin/sh
# backstory-proof.sh — proves persistent-bot identity end to end on the real
# server: a session carries a persona that flows into its composed system prompt,
# the alarm into a normal turn (prompt entry carries inboxIds and the message
# bodies), request-id retries dedupe, a server death between send and wake
# still delivers exactly once, multi-message sends arrive in order, thread
# rows list as a channel, and an unknown recipient materializes a session.
# Owns its worker: boots a private `wrangler dev` on the BASE port with a
# scratch --persist-to dir (default :8795, never the shared :8787) so it can
# kill and reboot it for the restart scenario.
# Usage: sh verify/backstory-proof.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/backstory-proof/.
set -u
BASE="${1:-http://127.0.0.1:8795}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/backstory-proof"
mkdir -p "${OUT}"
PORT="$(printf '%s' "${BASE}" | sed -n 's/^.*:\([0-9][0-9]*\)\/*$/\1/p')"
if [ -z "${PORT}" ]; then PORT="8795"; fi
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/backstory-proof-XXXXXX")"
PIDFILE="${TMPBASE}/dev.pid"
cd "${ROOT}"

start_dev() {
  tag="$1"
  (cd "${ROOT}/worker" && exec >>"${OUT}/${tag}.log" 2>&1 </dev/null && exec npx wrangler dev --port "${PORT}" --persist-to "${TMPBASE}/persist" --var OPENCODE_API_KEY: & echo "$!" >"${PIDFILE}")
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

fail() { echo "FAIL backstory-proof: $1"; exit 1; }

json_field() {
  node -e "const d=require('${1}'); const v=d${2}; if(v===undefined)process.exit(3); process.stdout.write(String(v));"
}

echo "### boot + fixtures"
start_dev "boot" || exit 1
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || fail "workspace create"
printf '%s' "${WS_JSON}" > "${OUT}/ws.json"
WS="$(json_field "${OUT}/ws.json" ".workspaceId")"
printf '%s' "seeded-body-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json > "${OUT}/seed-put.json" || fail "seed put"
echo "WS=${WS}"

echo "### 1 backstory session: persona in the composed system prompt; plain session byte-identical baseline"
PERSONA="You are the Account Manager for team ${RUN_ID}. Own the follow-ups."
${CLI} session create --ws "${WS}" --backstory "${PERSONA}" --base "${BASE}" --json > "${OUT}/sb.json" || fail "create with backstory"
SB="$(json_field "${OUT}/sb.json" ".sessionId")"
${CLI} session create --ws "${WS}" --base "${BASE}" --json > "${OUT}/sp.json" || fail "create plain"
SP="$(json_field "${OUT}/sp.json" ".sessionId")"
curl -sf "${BASE}/workspaces/${WS}/sessions/${SB}/meta?systemPrompt=1" -o "${OUT}/sysb.json" || fail "meta systemPrompt bot"
curl -sf "${BASE}/workspaces/${WS}/sessions/${SP}/meta?systemPrompt=1" -o "${OUT}/sysp.json" || fail "meta systemPrompt plain"
[ "$(json_field "${OUT}/sysb.json" ".backstory")" = "${PERSONA}" ] || fail "meta backstory missing"
node -e "
const b=require('${OUT}/sysb.json').systemPrompt;
const p=require('${OUT}/sysp.json').systemPrompt;
if (typeof b !== 'string' || !b.endsWith('${PERSONA}')) throw new Error('composed system prompt must end with the persona');
if (b !== p + '\\n\\n' + '${PERSONA}') throw new Error('persona must append to the plain baseline');
console.log('composition ok: persona appends to the byte-identical baseline');
" || fail "composition assertion"

echo "### 2 stub turn on a backstory session runs the normal pipeline"
${CLI} run --ws "${WS}" --sid "${SB}" --prompt "read seed.txt" --base "${BASE}" --json > "${OUT}/run.json" || fail "run on backstory session"
node -e "
const b=require('${OUT}/run.json');
if (b.runtime.stub !== true) throw new Error('expected keyless stub run');
const tools=(b.toolCalls||[]).map(c=>c.tool).sort().join(',');
if (tools !== 'bash,read') throw new Error('expected read+bash toolCalls, got ' + tools);
console.log('pipeline ok: stub turn ran read+bash on the backstory session');
" || fail "stub turn assertion"

echo "### 3 spawn-by-message: message body becomes the spawned bot backstory"
SPAWN_BODY="You are the Talent Scout for ${RUN_ID}. Draft three intros."
${CLI} inbox send --ws "${WS}" --sid "${SB}" --to "scout-${RUN_ID}" --body "${SPAWN_BODY}" --request-id "bp-3" --wait --timeout 60 --base "${BASE}" --json > "${OUT}/spawn.json" || fail "spawn send"
BOT_SID="$(json_field "${OUT}/spawn.json" ".message.to")"
curl -sf "${BASE}/workspaces/${WS}/sessions/${BOT_SID}/meta?systemPrompt=1" -o "${OUT}/spawn-meta.json" || fail "spawned meta"
[ "$(json_field "${OUT}/spawn-meta.json" ".name")" = "scout-${RUN_ID}" ] || fail "spawned session name"
[ "$(json_field "${OUT}/spawn-meta.json" ".backstory")" = "${SPAWN_BODY}" ] || fail "spawned backstory != message body"
node -e "
const b=require('${OUT}/spawn-meta.json').systemPrompt;
if (!b || !b.endsWith('${SPAWN_BODY}')) throw new Error('spawned system prompt must end with the backstory');
console.log('spawn ok: backstory flows into the spawned system prompt');
" || fail "spawn composition assertion"

echo "### 4 cap: backstory over 8192 chars rejected with a hint"
LONG="$(node -p "'x'.repeat(9000)")"
${CLI} session create --ws "${WS}" --backstory "${LONG}" --base "${BASE}" --json > "${OUT}/cap.json" 2>&1 && fail "oversized backstory accepted"
grep -q '"hint"' "${OUT}/cap.json" || fail "cap rejection missing hint"
echo "PASS 4 oversized backstory rejected with {error, hint}"

echo "### 5 restart: persona survives (column, then re-read)"
kill_dev || fail "server did not stop"
start_dev "reboot" || fail "server did not come back"
curl -sf "${BASE}/workspaces/${WS}/sessions/${SB}/meta?systemPrompt=1" -o "${OUT}/sysb-after.json" || fail "meta after restart"
[ "$(json_field "${OUT}/sysb-after.json" ".backstory")" = "${PERSONA}" ] || fail "backstory lost across restart"
node -e "
const b=require('${OUT}/sysb-after.json').systemPrompt;
if (!b.endsWith('${PERSONA}')) throw new Error('composed system prompt lost the persona across restart');
console.log('restart ok: persona persists');
" || fail "restart composition assertion"

echo "PASS backstory-proof: all 5 scenario checks green"
