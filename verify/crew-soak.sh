#!/bin/sh
# crew-soak.sh — teammate-layer soak: one workspace, a 3-bot crew on 60s
# interval routines plus live inbox/group traffic, across two kill -9 plus
# restart cycles, then a storage-backed census.
# Each bot is a named session (name + backstory) with one interval routine
# (spec 60, the floor) firing "read seed.txt" stub turns. While the beats
# fire, the script passes bot-to-bot inbox sends (distinct request-ids, a
# few with --wait) and group fan-outs; sends run in a loop through the
# window so some land while a recipient is mid-turn. PI_TEST_HOLD_TURN_MS
# parks each turn open ~4s before model output, so mid-turn sends and
# mid-turn kills happen by construction instead of racing ~0.3s stub turns.
# The dev server is SIGKILLed twice mid-window via the recorded PID tree
# (nightly-soak's kill9_port) and rebooted on the same port with the same
# --persist-to.
# Census, all from second views (entries --all, meta, inbox list, groups
# messages, routines list):
# - every routine's runCount equals the expected beat count, simulated from
#   recorded ready/kill timestamps: a beat claims at max(due, window start)
#   plus alarm lag, overdue beats collapse to ONE claim at the next window
#   start (next_run_at recomputes from claim time, never catch-up). The
#   claim lag and window-edge fuzz sweep a range; runCount must land inside
#   it. A kill mid-claim can consume a beat without a prompt entry, so
#   prompt entries per routineId sit in [runCount - kills, runCount].
# - every sent message row: exactly one row per request-id (group sends
#   carry requestId:toSid), delivered_at plus outcome_cursor set; consuming
#   prompt entries per inboxId in [1, 1 + kills after its createdAt] —
#   at-least-once redelivery across a kill is correct, silent loss or
#   unbounded duplication is not.
# - entry cursors gapless: pi_entries ids are global AUTOINCREMENT, so the
#   UNION across the three sessions (live entries plus archive pages — the
#   stub's 1000-token window keeps every session over the compaction
#   reserve, so archiving runs mid-soak) must be contiguous 1..max with no
#   holes; per session live+archived rows equal count+archiveTotal and
#   meta.head equals the max cursor.
# - zero sessions with openRun true at census (after the settle poll).
# Sends that hit a dead server are retried once after reboot with the same
# request-id (the dedupe path absorbs a persisted-but-unacked original), so
# every recorded send maps to exactly one row. Unrecorded rows (response
# lost after the insert) still must satisfy the row/delivery invariants.
# Owns its worker: boots a private `wrangler dev` on the BASE port with a
# scratch --persist-to dir (default :8796, never :8787 shared dev), so it
# must NOT run against a shared server. Keyless: MODEL_ID and
# OPENCODE_API_KEY are stripped from the dev env and a stray worker/.dev.vars
# is parked for the run, so the stub model path stays deterministic.
# Usage: sh verify/crew-soak.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/crew-soak/.
set -u
BASE="${1:-http://127.0.0.1:8796}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/crew-soak"
mkdir -p "${OUT}"
PORT="$(printf '%s' "${BASE}" | sed -n 's/^.*:\([0-9][0-9]*\)\/*$/\1/p')"
if [ -z "${PORT}" ]; then PORT="8796"; fi
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/crew-soak-XXXXXX")"
PIDFILE="${TMPBASE}/dev.pid"
DEV_VARS="${ROOT}/worker/.dev.vars"
PREV_VARS="${TMPBASE}/prev-dev-vars"
SEED_BODY="seeded-body-${RUN_ID}"
SOAK_S=330
KILL_AT_1=150
KILL_AT_2=285
SETTLE_BUDGET_S=210
WALL_BUDGET_S=900
START_T="$(date +%s)"
now_ms() { node -p "Date.now()"; }
elapsed() { printf '%s' "$(( $(date +%s) - START_T ))"; }

start_dev() {
  BOOTN=0
  tag="$1"
  if [ -f "${TMPBASE}/bootn" ]; then BOOTN="$(cat "${TMPBASE}/bootn")"; fi
  BOOTN=$((BOOTN + 1))
  printf '%s' "${BOOTN}" > "${TMPBASE}/bootn"
  MYIPORT=$((PORT + 200 + BOOTN))
  i=0
  while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 30 ]; then
      echo "port ${PORT} still serves traffic after 30s; expected it free (fresh boot: pass a free BASE, default http://127.0.0.1:8796; restart: the kill -9 did not land)"
      return 1
    fi
    sleep 1
  done
  # Subshell-wide redirection: every descendant (npx re-spawns, npm exec,
  # update notifiers) inherits file fds. A per-command redirect misses
  # re-spawned children, which then hold the tee pipe open past the verdict
  # and wedge the pipeline exit forever.
  (cd "${ROOT}/worker" && exec >>"${OUT}/${tag}.log" 2>&1 </dev/null && env -u MODEL_ID -u OPENCODE_API_KEY npx wrangler dev --port "${PORT}" --inspector-port "${MYIPORT}" --persist-to "${TMPBASE}/persist" --var PI_TEST_HOLD_TURN_MS:4000 & echo "$!" >"${PIDFILE}")
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
  # SIGKILL a pid plus all of its descendants, deepest first. Descendant
  # tracking needs no cmdline cooperation.
  for c in $(pgrep -P "$1" 2>/dev/null); do rkill_tree "$c"; done
  kill -KILL "$1" 2>/dev/null || true
}
rkill_pattern() {
  # rkill every pid matching a pgrep -f pattern (children first via
  # rkill_tree, so reparented runtimes die with their supervisor branch).
  for p in $(pgrep -f "$1" 2>/dev/null); do
    if [ "${p}" != "$$" ]; then rkill_tree "${p}"; fi
  done
}
kill9_port() {
  # SIGKILL the whole chain at once. Three generations hide here: the npx
  # launcher, an npm exec layer that DETACHES (ppid 1 while the launcher
  # lives), cli.js, and workerd runtimes whose cmdline carries an ephemeral
  # socket-addr (entry=127.0.0.1:0), never our port. Patterns alone orphan the
  # detached runtimes; PIDFILE trees alone miss the detached npm branch.
  # So: tree kill by PIDFILE, tree kill by every matching supervisor
  # cmdline, then the entry=localhost backstop for primaries whose cmdline
  # carries the real port. Second sweeps catch restart racers. All patterns
  # pin our port only, never the shared :8787 dev.
  if [ -f "${PIDFILE}" ]; then
    rkill_tree "$(cat "${PIDFILE}")"
  fi
  rkill_pattern "wrangler dev --port ${PORT}([^0-9]|$)"
  rkill_pattern "npm exec wrangler dev --port ${PORT}([^0-9]|$)"
  rkill_pattern "cli\.js dev --port ${PORT}([^0-9]|$)"
  rkill_pattern "entry=localhost:${PORT}([^0-9]|$)"
  SILENCE=0
  while [ "${SILENCE}" -lt 10 ] && curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    SILENCE=$((SILENCE + 1))
    sleep 1
  done
  rkill_pattern "wrangler dev --port ${PORT}([^0-9]|$)"
  rkill_pattern "npm exec wrangler dev --port ${PORT}([^0-9]|$)"
  rkill_pattern "cli\.js dev --port ${PORT}([^0-9]|$)"
  rkill_pattern "entry=localhost:${PORT}([^0-9]|$)"
  rm -f "${PIDFILE}"
}

stop_dev() {
  if [ -f "${PIDFILE}" ]; then
    pid="$(cat "${PIDFILE}")"
    rm -f "${PIDFILE}"
    kill -TERM "${pid}" 2>/dev/null || true
    i=0
    while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "${i}" -ge 10 ]; then
        break
      fi
      sleep 1
    done
  fi
  kill9_port
}
cleanup() {
  if [ -n "${CLEANING:-}" ]; then
    return 0
  fi
  CLEANING=1
  echo "CLEANUP $(date +%s) $$" >> "${OUT}/cleanup.log"
  stop_dev
  echo "CLEANUP-STOPDEV $(date +%s) $$" >> "${OUT}/cleanup.log"
  for j in $(jobs -p 2>/dev/null); do kill -KILL "$j" 2>/dev/null || true; done
  if [ -f "${PREV_VARS}" ]; then
    cp "${PREV_VARS}" "${DEV_VARS}"
  else
    rm -f "${DEV_VARS}"
  fi
}
trap cleanup EXIT INT TERM

fail() { echo "FAIL crew-soak: $1"; exit 1; }

json_field() {
  node -e "const d=require('${1}'); const v=d${2}; if(v===undefined)process.exit(3); process.stdout.write(String(v));"
}

# record_send KIND FROM TO REQID WAIT MSGID_OR_DASH — one line per accepted send.
record_send() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$(now_ms)" >> "${OUT}/sends.tsv"
}

# send_one KIND FROM TO REQID WAIT — one send attempt; on success appends to
# sends.tsv, on failure appends the spec to retry.tsv (same request-id, so a
# persisted-but-unacked original dedupes on the retry).
send_one() {
  kind="$1" from="$2" to="$3" reqid="$4" wait="$5"
  body="crew-msg-${RUN_ID}-${reqid}"
  if [ "${kind}" = "group" ]; then
    if ${CLI} groups send --ws "${WS}" --id "${GID}" --from "${from}" --body "${body}" --request-id "${reqid}" --base "${BASE}" --json > "${OUT}/send-${reqid}.json" 2>"${OUT}/send-${reqid}.err"; then
      record_send "${kind}" "${from}" "${to}" "${reqid}" "${wait}" "-"
      echo "send ${reqid}: group fan-out from ${from}"
      return 0
    fi
  else
    if [ "${wait}" = "wait" ]; then
      ${CLI} inbox send --ws "${WS}" --sid "${from}" --to "${to}" --body "${body}" --request-id "${reqid}" --wait --timeout 45 --base "${BASE}" --json > "${OUT}/send-${reqid}.json" 2>"${OUT}/send-${reqid}.err"
    else
      ${CLI} inbox send --ws "${WS}" --sid "${from}" --to "${to}" --body "${body}" --request-id "${reqid}" --base "${BASE}" --json > "${OUT}/send-${reqid}.json" 2>"${OUT}/send-${reqid}.err"
    fi
    if [ "$?" = "0" ]; then
      mid="$(json_field "${OUT}/send-${reqid}.json" ".message.id" 2>/dev/null || printf '?')"
      record_send "${kind}" "${from}" "${to}" "${reqid}" "${wait}" "${mid}"
      echo "send ${reqid}: ${from} -> ${to} (${wait}) mid=${mid}"
      return 0
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "${kind}" "${from}" "${to}" "${reqid}" "${wait}" >> "${OUT}/retry.tsv"
  echo "send ${reqid}: attempt failed (server down or error); queued for retry"
  return 1
}

# drain_retries — re-attempt every queued send once per call; still-failing
# sends stay queued for the next call.
drain_retries() {
  [ -f "${OUT}/retry.tsv" ] || return 0
  mv "${OUT}/retry.tsv" "${OUT}/retry-inflight.tsv"
  while IFS="$(printf '\t')" read -r kind from to reqid wait; do
    [ -n "${reqid}" ] || continue
    send_one "${kind}" "${from}" "${to}" "${reqid}" "${wait}" || true
  done < "${OUT}/retry-inflight.tsv"
  rm -f "${OUT}/retry-inflight.tsv"
}

do_kill() {
  kn="$1"
  printf 'K\t%s\n' "$(now_ms)" >> "${OUT}/windows.tsv"
  echo "KILL ${kn} at $(elapsed)s"
  kill9_port
  rk=0
  while [ "${rk}" -lt 3 ]; do
    k=0
    while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
      k=$((k + 1))
      if [ "${k}" -ge 8 ]; then
        echo "RED assert-kill-landed: server still up 15s after kill -9"
        return 1
      fi
      sleep 2
    done
    sleep 3
    if curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; then
      echo "server came back (supervisor restart); killing again"
      kill9_port
      rk=$((rk + 1))
    else
      break
    fi
  done
  if [ "${rk}" -ge 3 ]; then
    echo "RED assert-kill-landed: server keeps auto-restarting after kill -9"
    return 1
  fi
  echo "server down and stable after kill ${kn}"
  DOWN_MS="$(now_ms)"
  sleep 8
  start_dev "reboot-${kn}" || return 1
  printf 'R\t%s\n' "$(now_ms)" >> "${OUT}/windows.tsv"
  echo "reboot ${kn} ready after $(( ($(now_ms) - DOWN_MS) / 1000 ))s down"
  return 0
}

{
echo "### 0 prereqs plus a private keyless dev on ${BASE}"
command -v node >/dev/null 2>&1 || { echo "node missing"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl missing"; exit 1; }
if [ -f "${DEV_VARS}" ]; then
  cp "${DEV_VARS}" "${PREV_VARS}"
  rm -f "${DEV_VARS}"
  echo "dev secret parked (keyless stub determinism; restored on exit)"
fi
start_dev boot || exit 1
printf 'R\t%s\n' "$(now_ms)" >> "${OUT}/windows.tsv"

echo "### 1 fixtures: workspace, seed, three named bots, one group"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || fail "workspace create"
printf '%s' "${WS_JSON}" > "${OUT}/ws.json"
WS="$(json_field "${OUT}/ws.json" ".workspaceId")"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json > "${OUT}/seed-put.json" || fail "seed put"
# Named bots need the route directly: the CLI's session create has no --name.
BOTS=""
NAMES=""
i=1
while [ "${i}" -le 3 ]; do
  name="bot-${i}-${RUN_ID}"
  curl -sf -X POST "${BASE}/workspaces/${WS}/sessions" -H 'content-type: application/json' \
    -d "{\"name\":\"${name}\",\"backstory\":\"You are ${name}, a crew bot in the soak.\"}" > "${OUT}/bot-${i}.json" || fail "bot ${i} create"
  sid="$(json_field "${OUT}/bot-${i}.json" ".sessionId")"
  BOTS="${BOTS} ${sid}"
  NAMES="${NAMES} ${name}"
  i=$((i + 1))
done
B1="$(printf '%s' "${BOTS}" | cut -d' ' -f2)"
B2="$(printf '%s' "${BOTS}" | cut -d' ' -f3)"
B3="$(printf '%s' "${BOTS}" | cut -d' ' -f4)"
N1="$(printf '%s' "${NAMES}" | cut -d' ' -f2)"
N2="$(printf '%s' "${NAMES}" | cut -d' ' -f3)"
N3="$(printf '%s' "${NAMES}" | cut -d' ' -f4)"
${CLI} groups create --ws "${WS}" --name "crew-${RUN_ID}" --members "${N1},${N2},${N3}" --base "${BASE}" --json > "${OUT}/group.json" || fail "group create"
GID="$(json_field "${OUT}/group.json" ".group.id")"
echo "WS=${WS} bots=${B1},${B2},${B3} group=${GID}"

echo "### 2 one interval-60 routine per bot"
i=1
for sid in ${BOTS}; do
  ${CLI} routines create --ws "${WS}" --sid "${sid}" --kind interval --spec 60 --prompt "read seed.txt" --request-id "crew-routine-${i}" --base "${BASE}" --json > "${OUT}/routine-${i}.json" || fail "routine create ${i}"
  rid="$(json_field "${OUT}/routine-${i}.json" ".routine.id")"
  nra="$(json_field "${OUT}/routine-${i}.json" ".routine.nextRunAt")"
  printf '%s\t%s\t%s\n' "${rid}" "${sid}" "${nra}" >> "${OUT}/routines.tsv"
  echo "routine ${rid} on ${sid} first=${nra}"
  i=$((i + 1))
done

echo "### 3 soak window ${SOAK_S}s: sends loop, kills at ${KILL_AT_1}s and ${KILL_AT_2}s"
: > "${OUT}/sends.tsv"
: > "${OUT}/retry.tsv"
SEQ=0
KILLS_DONE=0
while [ "$(elapsed)" -lt "${SOAK_S}" ]; do
  t="$(elapsed)"
  if [ "${KILLS_DONE}" -eq 0 ] && [ "${t}" -ge "${KILL_AT_1}" ]; then
    drain_retries
    do_kill 1 || exit 1
    KILLS_DONE=1
    drain_retries
    continue
  fi
  if [ "${KILLS_DONE}" -eq 1 ] && [ "${t}" -ge "${KILL_AT_2}" ]; then
    drain_retries
    do_kill 2 || exit 1
    KILLS_DONE=2
    drain_retries
    continue
  fi
  drain_retries
  SEQ=$((SEQ + 1))
  case $((SEQ % 9)) in
    3) send_one group "${B1}" "-" "g-${SEQ}" "nowait" || true ;;
    7) send_one group "${B2}" "-" "g-${SEQ}" "nowait" || true ;;
    5) send_one direct "${B2}" "${N3}" "m-${SEQ}" "wait" || true ;;
    8) send_one direct "${B3}" "${N1}" "m-${SEQ}" "wait" || true ;;
    0|1) send_one direct "${B1}" "${N2}" "m-${SEQ}" "nowait" || true ;;
    2|4) send_one direct "${B2}" "${B1}" "m-${SEQ}" "nowait" || true ;;
    6) send_one direct "${B3}" "${N2}" "m-${SEQ}" "nowait" || true ;;
  esac
  sleep 12
done
drain_retries
if [ -s "${OUT}/retry.tsv" ]; then
  echo "sends still undelivered after final retry pass:"
  cat "${OUT}/retry.tsv"
  fail "send retries exhausted"
fi
SENT_N="$(wc -l < "${OUT}/sends.tsv" | tr -d ' ')"
echo "PASS 3 soak window done: ${SENT_N} sends accepted across 2 kill/restarts"

echo "### 4 settle: every sent row delivered, no turn mid-commit"
# Delivery is the hard condition (a kill mid-wake-turn waits out the 120s
# reclaim). Beats keep firing through settle, so quiet is proven by head
# stability: every session's entry head unchanged across a 10s gap means no
# turn was mid-commit when the census reads start (a stub turn holds ~4s).
SETTLE_START="$(date +%s)"
LAST_HEADS=""
STABLE_SINCE=0
while :; do
  ALLDEL=1
  for sid in ${BOTS}; do
    ${CLI} inbox list --ws "${WS}" --sid "${sid}" --base "${BASE}" --json > "${OUT}/settle-inbox-${sid}.json" 2>/dev/null || { ALLDEL=0; break; }
    if node -e "const d=require('${OUT}/settle-inbox-${sid}.json'); process.exit(d.messages.some(m=>m.deliveredAt===null||m.deliveredAt===undefined)?1:0)"; then :; else ALLDEL=0; break; fi
  done
  HEADS=""
  for sid in ${BOTS}; do
    h="$(${CLI} meta --ws "${WS}" --sid "${sid}" --base "${BASE}" --json 2>/dev/null | node -p "JSON.parse(require('node:fs').readFileSync(0,'utf8')).head" 2>/dev/null || printf '?')"
    HEADS="${HEADS} ${h}"
  done
  if [ "${HEADS}" != "${LAST_HEADS}" ]; then
    LAST_HEADS="${HEADS}"
    STABLE_SINCE="$(date +%s)"
  fi
  if [ "${ALLDEL}" = "1" ] && [ "${STABLE_SINCE}" != "0" ] && [ "$(( $(date +%s) - STABLE_SINCE ))" -ge 10 ]; then
    break
  fi
  if [ "$(( $(date +%s) - SETTLE_START ))" -ge "${SETTLE_BUDGET_S}" ]; then
    echo "RED assert-settle: messages undelivered or entries still landing after ${SETTLE_BUDGET_S}s"
    exit 1
  fi
  sleep 5
done
echo "PASS 4 settle: all rows delivered, heads stable ($(( $(date +%s) - SETTLE_START ))s)"

echo "### 5 census: second views (live entries plus archive pages — stub sessions sit over the 1000-token window, so the compaction alarm archives mid-soak)"
# A beat can still claim mid-census: the runCount pair brackets the read and
# any movement retries the whole census (claims are ~60s apart per routine,
# so a retry converges).
CENSUS_TRY=0
while :; do
  CENSUS_TRY=$((CENSUS_TRY + 1))
  if [ "${CENSUS_TRY}" -gt 6 ]; then
    echo "RED assert-census-stable: runCount kept moving across 6 census reads"
    exit 1
  fi
  for sid in ${BOTS}; do
    ${CLI} routines list --ws "${WS}" --sid "${sid}" --base "${BASE}" --json > "${OUT}/census-routines-pre-${sid}.json" || fail "routines pre ${sid}"
    ${CLI} meta --ws "${WS}" --sid "${sid}" --base "${BASE}" --json > "${OUT}/census-meta-pre-${sid}.json" || fail "meta pre ${sid}"
  done
  for sid in ${BOTS}; do
    ${CLI} entries --ws "${WS}" --sid "${sid}" --all --base "${BASE}" --json > "${OUT}/census-entries-${sid}.json" || fail "entries ${sid}"
    ${CLI} meta --ws "${WS}" --sid "${sid}" --base "${BASE}" --json > "${OUT}/census-meta-${sid}.json" || fail "meta ${sid}"
    ${CLI} inbox list --ws "${WS}" --sid "${sid}" --base "${BASE}" --json > "${OUT}/census-inbox-${sid}.json" || fail "inbox ${sid}"
    ${CLI} routines list --ws "${WS}" --sid "${sid}" --base "${BASE}" --json > "${OUT}/census-routines-${sid}.json" || fail "routines ${sid}"
    PAGES="$(json_field "${OUT}/census-meta-${sid}.json" ".compaction.archivePages")"
    p=1
    while [ "${p}" -le "${PAGES}" ]; do
      ${CLI} archive --ws "${WS}" --sid "${sid}" --page "${p}" --base "${BASE}" --json > "${OUT}/census-archive-${sid}-p${p}.json" || fail "archive ${sid} p${p}"
      p=$((p + 1))
    done
  done
  ${CLI} groups messages --ws "${WS}" --id "${GID}" --base "${BASE}" --json > "${OUT}/census-group.json" || fail "group messages"
  CENSUS_END_MS="$(now_ms)"
  MOVED=0
  for sid in ${BOTS}; do
    if ! node -e "
const a=require('${OUT}/census-routines-pre-${sid}.json'), b=require('${OUT}/census-routines-${sid}.json');
const ma=require('${OUT}/census-meta-pre-${sid}.json'), mb=require('${OUT}/census-meta-${sid}.json');
const f=(d)=>d.routines.map(r=>r.id+':'+r.runCount).sort().join(',');
process.exit(f(a)===f(b) && ma.head===mb.head ? 0 : 1);
"; then MOVED=1; break; fi
  done
  if [ "${MOVED}" = "0" ]; then break; fi
  echo "census try ${CENSUS_TRY}: a routine claimed mid-read; retrying"
  sleep 8
done

OUT="${OUT}" CENSUS_END_MS="${CENSUS_END_MS}" node - "${OUT}" <<'NODEEOF'
const fs = require("node:fs");
const out = process.env.OUT;
const endMs = Number(process.env.CENSUS_END_MS);
const fails = [];
const notes = [];
const fail = (m) => fails.push(m);
const note = (m) => notes.push(m);

const tsv = (name) => fs.readFileSync(`${out}/${name}`, "utf8").split("\n").filter((l) => l.length > 0).map((l) => l.split("\t"));
const windows = [];
let cur = null;
for (const [tag, ms] of tsv("windows.tsv")) {
  if (tag === "R") { cur = { start: Number(ms), end: endMs }; windows.push(cur); }
  else if (tag === "K" && cur !== null) { cur.end = Number(ms); cur = null; }
}
const kills = tsv("windows.tsv").filter(([t]) => t === "K").map(([, ms]) => Number(ms));
const sends = tsv("sends.tsv").map(([kind, from, to, reqid, wait, mid, at]) => ({ kind, from, to, reqid, wait, mid, at: Number(at) }));
const routines = tsv("routines.tsv").map(([rid, sid, first]) => ({ rid, sid, firstMs: Date.parse(first) }));
const bots = routines.map((r) => r.sid);

const entriesOf = (sid) => JSON.parse(fs.readFileSync(`${out}/census-entries-${sid}.json`, "utf8"));
const allEntriesOf = (sid) => {
  const merged = [...entriesOf(sid).entries];
  const pages = metaOf(sid).compaction.archivePages;
  for (let p = 1; p <= pages; p++) {
    const d = JSON.parse(fs.readFileSync(`${out}/census-archive-${sid}-p${p}.json`, "utf8"));
    merged.push(...d.entries);
  }
  return merged;
};
const metaOf = (sid) => JSON.parse(fs.readFileSync(`${out}/census-meta-${sid}.json`, "utf8"));
const inboxOf = (sid) => JSON.parse(fs.readFileSync(`${out}/census-inbox-${sid}.json`, "utf8"));
const routinesOf = (sid) => JSON.parse(fs.readFileSync(`${out}/census-routines-${sid}.json`, "utf8"));
const groupMsgs = JSON.parse(fs.readFileSync(`${out}/census-group.json`, "utf8")).messages;

const promptEntries = (sid) => allEntriesOf(sid).filter((e) => e.type === "prompt");
const promptsForRoutine = (sid, rid) => promptEntries(sid).filter((e) => { try { const b = JSON.parse(e.body); return b.routineId === rid; } catch { return false; } });
const promptsForInbox = (sid, mid) => promptEntries(sid).filter((e) => { try { const b = JSON.parse(e.body); return Array.isArray(b.inboxIds) && b.inboxIds.includes(mid); } catch { return false; } });

// Expected beat count: a beat claims at max(due, window start) + lag; an
// overdue beat collapses into exactly one claim at the next window start
// (next_run_at recomputes from the claim). Sweep claim lag and window-edge
// fuzz; runCount must land inside the simulated range.
function simBeats(firstMs, lagMs, fuzzMs) {
  let t = firstMs;
  let n = 0;
  for (let guard = 0; guard < 200; guard++) {
    const w = windows.find((w) => t < w.end + fuzzMs);
    if (w === undefined) break;
    const c = Math.max(t, w.start - fuzzMs) + lagMs;
    if (c < w.end + fuzzMs) { n += 1; t = c + 60000; continue; }
    const nw = windows[windows.indexOf(w) + 1];
    if (nw === undefined) break;
    t = Math.max(t, nw.start - fuzzMs);
  }
  return n;
}
let routineOk = true;
for (const r of routines) {
  const list = routinesOf(r.sid).routines.find((x) => x.id === r.rid);
  if (list === undefined) { fail(`routine ${r.rid} missing from list`); routineOk = false; continue; }
  let lo = Infinity, hi = -Infinity;
  for (const lag of [0, 5000, 15000, 30000]) {
    for (const fuzz of [-3000, 0, 3000]) {
      const n = simBeats(r.firstMs, lag, fuzz);
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  }
  const prompts = promptsForRoutine(r.sid, r.rid).length;
  if (list.runCount < lo || list.runCount > hi) {
    fail(`routine ${r.rid} runCount ${list.runCount} outside expected [${lo},${hi}]`);
    routineOk = false;
  }
  if (prompts > list.runCount || prompts < list.runCount - kills.length) {
    fail(`routine ${r.rid} prompt entries ${prompts} outside [${list.runCount - kills.length},${list.runCount}]`);
    routineOk = false;
  }
  note(`routine ${r.rid}: runCount=${list.runCount} expected=[${lo},${hi}] prompts=${prompts}`);
}
if (routineOk) console.log(`PASS 5 routines: every runCount inside its simulated beat window, prompt entries consistent`);

// Message census: a direct send owns rows with requestId === reqid; a group
// fan-out owns rows with requestId === reqid:toSid. Every row needs
// deliveredAt plus outcomeCursor; every recorded send maps to exactly one
// row per expected recipient; prompt entries per inboxId stay inside the
// at-least-once bound.
const allRows = [];
for (const sid of bots) for (const m of inboxOf(sid).messages) allRows.push(m);
const seen = new Set();
const rows = allRows.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
const rowsFor = (s) => rows.filter((m) => m.requestId === s.reqid || (s.kind === "group" && typeof m.requestId === "string" && m.requestId.startsWith(`${s.reqid}:`)));
const claimed = new Set();
let msgOk = true;
for (const s of sends) {
  const mine = rowsFor(s);
  for (const m of mine) claimed.add(m.id);
  const want = s.kind === "group" ? 2 : 1;
  if (mine.length !== want) { fail(`send ${s.reqid}: ${mine.length} rows, want ${want}`); msgOk = false; }
}
for (const m of rows) {
  if (!claimed.has(m.id)) note(`unrecorded row ${m.id} requestId=${m.requestId} (response lost after insert)`);
  if (m.deliveredAt === null || m.deliveredAt === undefined) { fail(`message ${m.id} (${m.requestId}) never delivered`); msgOk = false; continue; }
  if (m.outcomeCursor === null || m.outcomeCursor === undefined) { fail(`message ${m.id} (${m.requestId}) missing outcomeCursor`); msgOk = false; }
  const createdMs = Date.parse(m.createdAt);
  const bound = 1 + kills.filter((k) => k > createdMs).length;
  const n = promptsForInbox(m.to, m.id).length;
  if (n < 1 || n > bound) {
    fail(`message ${m.id} (${m.requestId}) consumed by ${n} prompt entries, want 1..${bound}`);
    msgOk = false;
  }
}
if (msgOk) console.log(`PASS 6 messages: ${rows.length} rows, one per request-id, all delivered with outcome cursors, consume counts inside at-least-once bounds`);

// Gapless cursors: pi_entries ids are global AUTOINCREMENT, so the union
// across sessions (live plus archive) must be contiguous 1..max; per
// session live+archived rows equal count+archiveTotal and meta.head equals
// the max cursor.
let curOk = true;
const all = [];
for (const sid of bots) {
  const meta = metaOf(sid);
  const cursors = allEntriesOf(sid).map((e) => e.cursor);
  const want = meta.count + meta.compaction.archiveTotal;
  if (cursors.length !== want) { fail(`${sid}: live+archived entries ${cursors.length} != count+archiveTotal ${want}`); curOk = false; }
  const max = cursors.length === 0 ? 0 : Math.max(...cursors);
  if (meta.head !== max) { fail(`${sid}: meta.head ${meta.head} != max cursor ${max}`); curOk = false; }
  if (meta.openRun !== null && meta.openRun !== undefined) { fail(`${sid}: openRun ${meta.openRun} still open at census`); curOk = false; }
  for (const c of cursors) all.push(c);
}
all.sort((a, b) => a - b);
for (let i = 0; i < all.length; i++) {
  if (all[i] !== i + 1) { fail(`cursor union has a hole/dup at position ${i + 1}: saw ${all[i]}`); curOk = false; break; }
}
if (curOk) console.log(`PASS 7 cursors: union contiguous 1..${all.length} across ${bots.length} sessions, heads match, zero open runs`);

// Group channel second view: every group send produced its member rows on
// the group thread.
let grpOk = true;
for (const s of sends.filter((s) => s.kind === "group")) {
  const n = groupMsgs.filter((m) => typeof m.requestId === "string" && m.requestId.startsWith(`${s.reqid}:`)).length;
  if (n !== 2) { fail(`group send ${s.reqid}: ${n} channel rows, want 2`); grpOk = false; }
}
if (grpOk) console.log(`PASS 8 group channel: every fan-out lists one row per non-sender member`);

for (const m of notes) console.log(`note ${m}`);
if (fails.length > 0) {
  for (const m of fails) console.log(`FAIL ${m}`);
  process.exit(1);
}
console.log("PASS crew-soak: all checks green");
NODEEOF
CENSUS_RC=$?
[ "${CENSUS_RC}" = "0" ] || exit 1

if [ "$(elapsed)" -gt "${WALL_BUDGET_S}" ]; then
  echo "RED assert-timebox: ${WALL_BUDGET_S}s exceeded"
  exit 1
fi
} 2>&1 | tee "${OUT}/transcript.txt"
if grep -qm1 "^PASS crew-soak: all checks green" "${OUT}/transcript.txt"; then
  exit 0
fi
exit 1
