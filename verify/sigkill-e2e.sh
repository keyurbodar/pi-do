#!/bin/sh
# sigkill-e2e.sh — proves Wave 2 durable turns survive kill -9 mid-turn.
# Seed a session, capture a reference result from one uninterrupted stub
# stream turn, start a second identical stream turn, kill -9 the worker
# mid-stream (before {done}), restart the worker against the same
# --persist-to dir, wait for the recovery scan, then assert the turn
# completes with byte-exact reference text, pi_chunks seqs stay contiguous
# per turnId, attempts is recorded on the retried turn, and the entries
# replay stays gapless (no duplicated committed entry).
# Classify split (aligned with the recovery lane): a contiguous-chunks kill
# takes the continue path, which records no attempt by design — so the proof
# scenario forces the retry path by emptying the killed turn's pi_chunks rows
# with sqlite surgery while the worker is down (simulating lost tail
# flushes). The scan then records attempts=1 BEFORE the fresh redrive and
# deletes the row on commit, so attempts is observed via a transient latch
# (sub-second sqlite sampling during the wait), never as a surviving row —
# a surviving row on green would contradict commit-delete plus flat census.
# Owns its worker: boots a private `wrangler dev` on the BASE port with a
# scratch --persist-to dir (default :8793, never :8787 shared dev), so it
# must NOT run against a shared server and stays out of fast-battery's
# parallel tier (same reason bg-process and hibernate-proof are excluded:
# it kill -9s its server). Battery shape is kept so fast-battery can adopt
# it later: one optional BASE arg, artifacts/RUN_ID/sigkill-e2e/, a single
# PASS line, exit 1 otherwise.
# RED state (no wired scan): the killed turn stays orphaned/incomplete after
# restart — no post-wake result, no latched or surviving attempt — so
# assert-post-wake-result trips first, with assert-attempts right behind it.
# On recovery-lane completion this script must go green unmodified.
# Usage: sh verify/sigkill-e2e.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/sigkill-e2e/.
set -u
BASE="${1:-http://127.0.0.1:8793}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/sigkill-e2e"
mkdir -p "${OUT}"
PORT="$(printf '%s' "${BASE}" | sed -n 's/^.*:\([0-9][0-9]*\)\/*$/\1/p')"
if [ -z "${PORT}" ]; then PORT="8793"; fi
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/sigkill-e2e-XXXXXX")"
PIDFILE="${TMPBASE}/dev.pid"
DEV_VARS="${ROOT}/worker/.dev.vars"
PREV_VARS="${TMPBASE}/prev-dev-vars"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
SEED_BODY="seeded-body-${RUN_ID}"
MARKER="harness-bash-ok"
PROMPT="read seed.txt"
# Chaos hold: PI_TEST_HOLD_TURN_MS parks every turn open (row plus prompt
# committed, no model output) so the blind kill lands mid-turn by
# construction, never by racing a ~25ms stub turn. The secrets file stays
# parked (keyless stub determinism); this writes a hook-only .dev.vars for
# pre-kill boots and removes it before the restart, so the redrive runs
# clean. Reference turns absorb one 10s hold each; worth it for determinism.
hook_on() {
  printf 'PI_TEST_HOLD_TURN_MS=10000\n' > "${DEV_VARS}"
}
hook_off() {
  rm -f "${DEV_VARS}"
}
start_dev() {
  BOOTN=0
  tag="$1"
  if [ -f "${TMPBASE}/bootn" ]; then BOOTN="$(cat "${TMPBASE}/bootn")"; fi
  BOOTN=$((BOOTN + 1))
  printf '%s' "${BOOTN}" > "${TMPBASE}/bootn"
  MYIPORT=$((PORT + 100 + BOOTN))
  i=0
  while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 30 ]; then
      echo "port ${PORT} still serves traffic after 30s; expected it free (fresh boot: pass a free BASE, default http://127.0.0.1:8793; restart: the kill -9 did not land)"
      return 1
    fi
    sleep 1
  done
  # Subshell-wide redirection: every descendant (npx re-spawns, npm exec,
  # update notifiers) inherits file fds. A per-command redirect misses
  # re-spawned children, which then hold the tee pipe open past the verdict
  # and wedge the pipeline exit forever.
  (cd "${ROOT}/worker" && exec >>"${OUT}/${tag}.log" 2>&1 </dev/null && env -u MODEL_ID -u OPENCODE_API_KEY npx wrangler dev --port "${PORT}" --inspector-port "${MYIPORT}" --persist-to "${TMPBASE}/persist" & echo "$!" >"${PIDFILE}")
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
  # lives, holding the tee pipe with pre-fix redirections), cli.js, and
  # workerd runtimes whose cmdline carries an ephemeral socket-addr
  # (entry=127.0.0.1:0), never our port. Patterns alone orphan the
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
  sleep 2
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
    # Plain pid signal only: negative-pid group kills proved unreliable
    # here (job-control groupings shift under wrangler's supervisor), and
    # kill9_port below does the real pattern-based sweep anyway.
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
  # Guard against re-entry: a signal arriving mid-cleanup must not recurse.
  if [ -n "${CLEANING:-}" ]; then
    return 0
  fi
  CLEANING=1
  echo "CLEANUP $(date +%s) $$" >> "${OUT}/cleanup.log"
  stop_dev
  echo "CLEANUP-STOPDEV $(date +%s) $$" >> "${OUT}/cleanup.log"
  # control it blocks on any surviving child past the verdict.
  for j in $(jobs -p 2>/dev/null); do kill -KILL "$j" 2>/dev/null || true; done
  if [ -f "${PREV_VARS}" ]; then
    cp "${PREV_VARS}" "${DEV_VARS}"
  else
    rm -f "${DEV_VARS}"
  fi
}
trap cleanup EXIT INT TERM
do_reference() {
  # One uninterrupted stub stream turn on the current fence. Refreshes the
  # reference files, rotates F_CUR/R_CUR, and calibrates L_REF (prompt-entry
  # latency) for the blind kill delay. $1 = round tag for evidence files.
  rtag="$1"
  STREAM_REF="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F_CUR}&expected=${R_CUR}"
  WS_URL="${STREAM_REF}" MODE=ref PROMPT="${PROMPT}" FENCE="${F_CUR}" EXPECTED="${R_CUR}" OUTFILE="${OUT}/frames-ref-${rtag}.json" node "${OUT}/ws-client.mjs" || return 1
  SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-ref-${rtag}.json', 'utf8'));
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error('reference turn missing {done}');
if (!done.turnId || typeof done.turnId !== 'string') throw new Error('reference done must carry turnId');
if (!done.runtime || done.runtime.provider !== 'stub' || done.runtime.model !== 'stub') {
  throw new Error('keyless stub only: reference runtime=' + JSON.stringify(done.runtime));
}
const first = b.frames.find((f) => f.entry);
if (!first || typeof first.t !== 'number' || typeof b.sentAt !== 'number' || b.sentAt <= 0) {
  throw new Error('reference frames lack timing (sentAt/entry t)');
}
const latencyMs = first.t - b.sentAt;
if (!(latencyMs >= 0) || latencyMs > 30000) throw new Error('implausible prompt latency ' + latencyMs);
fs.writeFileSync('${OUT}/reference.txt', String(done.result));
fs.writeFileSync('${OUT}/reference-turn.json', JSON.stringify({ turnId: done.turnId, fence: done.fence, revision: done.revision }));
fs.writeFileSync('${OUT}/reference-cal.json', JSON.stringify({ turnId: done.turnId, latencyMs }));
console.log('reference ok: turn ' + done.turnId + ' revision ' + done.revision + ' result ' + String(done.result).length + ' bytes, prompt latency ' + latencyMs + 'ms');
" || return 1
  F_CUR="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames-ref-${rtag}.json','utf8')).frames.find((f)=>f.done===true).fence")"
  R_CUR="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames-ref-${rtag}.json','utf8')).frames.find((f)=>f.done===true).revision")"
  L_REF="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/reference-cal.json','utf8')).latencyMs")"
  cp "${OUT}/frames-ref-${rtag}.json" "${OUT}/frames-ref.json"
  echo "F_CUR=${F_CUR} R_CUR=${R_CUR} L_REF=${L_REF}"
}

{
echo "### 0 prereqs plus a private keyless dev on ${BASE}"
command -v node >/dev/null 2>&1 || { echo "node missing"; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 missing"; exit 1; }
node -e "if (typeof WebSocket === 'undefined') { process.exit(1); }" || { echo "node has no global WebSocket (need node >= 22)"; exit 1; }
if [ -f "${DEV_VARS}" ]; then
  cp "${DEV_VARS}" "${PREV_VARS}"
  rm -f "${DEV_VARS}"
  echo "dev secret parked (keyless stub determinism; restored on exit)"
fi
hook_on
start_dev dev1 || exit 1

echo "### 1 workspace create plus session"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"

echo "### 2 write the node WS client (global WebSocket, zero deps)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const MODE = process.env.MODE || "ref";
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
// Burst mode chains COUNT sequential turns on one socket (each done frame's
// fence feeds the next prompt) so a single blind kill lands mid-burst with
// wide margins on both sides. The stub turn is ~30ms; one socket turn is a
// coin flip, twelve is a certainty.
const COUNT = Number(process.env.COUNT || "1");
let sent = 0;
let dones = 0;
let curFence = FENCE;
let curExpected = EXPECTED;
function sendPrompt() {
  sent += 1;
  const frame = { prompt: PROMPT };
  if (curFence !== undefined) {
    frame.fence = curFence;
    frame.expected = curExpected;
  }
  sock.send(JSON.stringify(frame));
}
import { writeFileSync } from "node:fs";

const frames = [];
let close = null;
let settled = false;
let sentAt = 0;
function snapshot() {
  try {
    writeFileSync(OUTFILE, JSON.stringify({ frames, close, sentAt }, null, 2));
  } catch {
    // The polled file may race the kill; the next frame rewrites it.
  }
}
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    writeFileSync(OUTFILE, JSON.stringify({ frames, close, sentAt, note: note || null }, null, 2));
  } catch {
    // Best effort after kill -9; the frames already snapshotted stand.
  }
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 60000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  sendPrompt();
  sentAt = Date.now();
  snapshot();
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frame.t = Date.now();
  frames.push(frame);
  snapshot();
  if (frame.done === true) {
    dones += 1;
    curFence = frame.fence;
    curExpected = frame.revision;
    if (MODE === "burst" && sent < COUNT) {
      sendPrompt();
      return;
    }
  }
  if (frames.some((f) => f.done === true) && (MODE === "ref" || sent >= COUNT)) {
    try {
      sock.close(1000, "client done");
    } catch {
      // Already closing; the fallback below still records the frames.
    }
    setTimeout(() => finish(0, "done received; closed optimistically"), 1000);
  }
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  finish(0, null);
};
sock.onerror = () => {
  // A close event follows; it records the outcome.
};
EOF
echo "client written"

echo "### 3-4 calibrated rounds: reference turn, then a held mid-turn kill"
echo "Each round reboots if needed, runs one uninterrupted reference turn"
echo "(refreshing the byte-exact reference), then opens a kill turn parked by"
echo "PI_TEST_HOLD_TURN_MS (row plus prompt committed, model held 10s) and"
echo "fires on the first entry frame. Orphans are read from the store."
F_CUR="${F0}"
R_CUR="${R0}"
L_REF=""
ATTEMPT=0
KILLED=""
while [ "${ATTEMPT}" -lt 8 ] && [ -z "${KILLED}" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "--- round ${ATTEMPT}"
  if ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; then
    hook_on
    start_dev "dev-round-${ATTEMPT}" || exit 1
  fi
  do_reference "round-${ATTEMPT}" || exit 1
  DELAY_MS=$((L_REF + 100))
  if [ "${DELAY_MS}" -gt 400 ]; then DELAY_MS=400; fi
  if [ "${DELAY_MS}" -lt 50 ]; then DELAY_MS=50; fi
  echo "kill deadline ${DELAY_MS}ms after open (prompt latency ${L_REF}ms)"
  KILLFILE="${OUT}/frames-kill-${ATTEMPT}.json"
  rm -f "${KILLFILE}"
  # Store-proof baseline: a result entry above this head after the kill
  # proves the turn finished underneath us, no matter what the client saw.
  PREKILL_HEAD="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1 --base "${BASE}" --json 2>/dev/null | node -p "JSON.parse(require('node:fs').readFileSync(0,'utf8')).head" 2>/dev/null || echo 0)"
  WS_URL="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F_CUR}&expected=${R_CUR}" MODE=burst COUNT=12 PROMPT="${PROMPT}" FENCE="${F_CUR}" EXPECTED="${R_CUR}" OUTFILE="${KILLFILE}" node "${OUT}/ws-client.mjs" >>"${OUT}/client-kill-${ATTEMPT}.log" 2>&1 &
  CLIENTPID=$!
  i=0
  while [ ! -s "${KILLFILE}" ]; do
    if ! kill -0 "${CLIENTPID}" 2>/dev/null; then
      echo "watch client died before open"
      break
    fi
    i=$((i + 1))
    if [ "${i}" -ge 500 ]; then
      echo "socket never opened within 5s"
      break
    fi
    sleep 0.01
  done
  if [ ! -s "${KILLFILE}" ]; then
    kill "${CLIENTPID}" 2>/dev/null || true
    wait "${CLIENTPID}" 2>/dev/null || true
    echo "no open to kill on; retrying"
    continue
  fi
  N=$((DELAY_MS / 15 + 1))
  n=0
  FIRED=""
  while [ "${n}" -lt "${N}" ]; do
    # Fire the instant the first entry frame lands. The pre-prompt ledger
    # open guarantees turn 1's orphan row already exists, and the 11 turns
    # behind it stretch the burst far past observer latency: the kill always
    # lands with a live turn mid-stream. Any fixed sleep only risks the far
    # edge of the burst.
    if grep -q '"entry"' "${KILLFILE}" 2>/dev/null; then
      FIRED="entry"
      break
    fi
    if ! kill -0 "${CLIENTPID}" 2>/dev/null; then
      break
    fi
    n=$((n + 1))
    sleep 0.01
  done
  if [ -z "${FIRED}" ]; then
    FIRED="deadline"
  fi
  echo "firing kill -9 (${FIRED}, deadline ${DELAY_MS}ms)"
  T_FIRE="$(node -p "Date.now()")"
  pgrep -f 'workerd.*serve' 2>/dev/null | sort -n > "${OUT}/workerd-before-${ATTEMPT}.txt" || true
  kill9_port
  j=0
  while kill -0 "${CLIENTPID}" 2>/dev/null; do
    j=$((j + 1))
    if [ "${j}" -ge 150 ]; then
      kill -KILL "${CLIENTPID}" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done
  wait "${CLIENTPID}" 2>/dev/null || true
  rk=0
  while [ "${rk}" -lt 3 ]; do
    k=0
    while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
      k=$((k + 1))
      if [ "${k}" -ge 8 ]; then
        echo "RED assert-kill-landed: server still up 15s after kill -9"
        exit 1
      fi
      sleep 2
    done
    sleep 3
    if curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; then
      echo "server came back (supervisor restart); killing again (round $((rk + 2)))"
      kill9_port
      rk=$((rk + 1))
    else
      break
    fi
  done
  if [ "${rk}" -ge 3 ]; then
    echo "RED assert-kill-landed: server keeps auto-restarting after kill -9"
    exit 1
  fi
  echo "server down and stable after kill -9"
  T_DEAD="$(node -p "Date.now()")"
  # No ghost may survive with the parked turn inside it: a runtime orphaned
  # by a pattern-only sweep keeps the sqlite FD and completes the turn
  # invisibly, forging the recovery. Any pre-kill workerd still alive now
  # fails the round loudly instead.
  GHOSTS=""
  for p in $(cat "${OUT}/workerd-before-${ATTEMPT}.txt" 2>/dev/null); do
    if kill -0 "${p}" 2>/dev/null; then
      pp="$(ps -o ppid= -p "${p}" 2>/dev/null | tr -d ' ')"
      if [ "${pp}" = "1" ]; then
        GHOSTS="${GHOSTS} ${p}"
      fi
    fi
  done
  if [ -n "${GHOSTS}" ]; then
    echo "ghost stray: workerd survived kill -9 with ppid 1:${GHOSTS}; killed, store truth below decides the round"
    for p in ${GHOSTS}; do kill -KILL "${p}" 2>/dev/null || true; done
  fi
  # Store truth, not client frames: surviving pi_runs rows are the orphans,
  # whatever the client saw. Committed burst turns have no rows; unstarted
  # turns never opened one. Zero rows plus fresh results means the burst ran
  # past the kill (retry); zero rows and nothing new means vacuous (retry).
  KILL_SQLITE=""
  for f in $(find "${TMPBASE}" -name "*.sqlite" 2>/dev/null); do
    if sqlite3 "${f}" "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_runs';" 2>/dev/null | grep -q pi_runs; then
      if sqlite3 "${f}" "SELECT 1 FROM pi_runs WHERE sid = '${SID}' LIMIT 1;" 2>/dev/null | grep -q 1; then
        KILL_SQLITE="${f}"
        break
      fi
    fi
  done
  if [ -z "${KILL_SQLITE}" ]; then
    for f in $(find "${TMPBASE}" -name "*.sqlite" 2>/dev/null); do
      if sqlite3 "${f}" "SELECT 1 FROM pi_entries WHERE sid = '${SID}' LIMIT 1;" 2>/dev/null | grep -q 1; then
        KILL_SQLITE="${f}"
        break
      fi
    done
  fi
  ORPHANS=""
  if [ -n "${KILL_SQLITE}" ]; then
    ORPHANS="$(sqlite3 "${KILL_SQLITE}" "SELECT turnId FROM pi_runs WHERE sid = '${SID}';")"
  fi
  if [ -n "${ORPHANS}" ]; then
    N_ORPHANS="$(printf '%s' "${ORPHANS}" | grep -c .)"
    KILLED="attempt-${ATTEMPT}"
    cp "${KILLFILE}" "${OUT}/frames-kill.json"
    printf '%s\n' "${ORPHANS}" > "${OUT}/orphans.txt"
    echo "killed mid-burst on ${KILLED}: ${N_ORPHANS} orphan(s) for the scan"
  else
    echo "no orphan rows (burst finished past the kill, or vacuous); refreshing fence and retrying"
    if [ -n "${KILL_SQLITE}" ]; then
      FENCEROW="$(sqlite3 "${KILL_SQLITE}" "SELECT ownerFence || '|' || revision FROM sessions WHERE sid = '${SID}' LIMIT 1;" 2>/dev/null)"
      F_CUR="$(printf '%s' "${FENCEROW}" | cut -d'|' -f1)"
      R_CUR="$(printf '%s' "${FENCEROW}" | cut -d'|' -f2)"
      if [ -z "${F_CUR}" ] || [ -z "${R_CUR}" ]; then echo "RED assert-fence: cold store has no fence for sid"; exit 1; fi
      echo "F_CUR=${F_CUR} R_CUR=${R_CUR}"
    fi
  fi
done
if [ -z "${KILLED}" ]; then
  echo "RED assert-mid-stream-kill: could not catch a stub turn mid-stream in 8 attempts"
  exit 1
fi
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-kill.json', 'utf8'));
const entries = b.frames.filter((f) => f.entry);
if (entries.length === 0) throw new Error('need at least the prompt entry pre-kill');
const cursors = entries.map((f) => f.entry.cursor);
fs.writeFileSync('${OUT}/prekill.json', JSON.stringify({ count: entries.length, maxCursor: Math.max(...cursors), runId: entries[0].entry.body ? JSON.parse(entries[0].entry.body).runId : null }));
fs.writeFileSync('${OUT}/kill-timing.json', JSON.stringify({ attempt: '${KILLED}', fireMs: Number('${T_FIRE}'), deadMs: Number('${T_DEAD}') }));
" || exit 1
PREKILL_MAX="$(node -p "require('${OUT}/prekill.json').maxCursor")"
echo "PREKILL_MAX=${PREKILL_MAX}"

echo "### 5 worker is down; operate on the cold persist dir, then restart it"
i=0
while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "${i}" -ge 15 ]; then
    echo "server still up 30s after kill -9"
    exit 1
  fi
  sleep 2
done
echo "disconnect observed and stable; the persist dir is cold"
SQLITE=""
for f in $(find "${TMPBASE}" -name "*.sqlite" 2>/dev/null); do
  if sqlite3 "${f}" "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_entries';" 2>/dev/null | grep -q pi_entries; then
    if sqlite3 "${f}" "SELECT 1 FROM pi_entries WHERE sid = '${SID}' LIMIT 1;" 2>/dev/null | grep -q 1; then
      SQLITE="${f}"
      break
    fi
  fi
done
if [ -z "${SQLITE}" ]; then
  echo "RED assert-sqlite: no persisted sqlite under ${TMPBASE} holds sid ${SID}"
  exit 1
fi
echo "sqlite ok: ${SQLITE}"
echo "### 5b chunk surgery: empty every orphan chunk log to force retry paths"
echo "A contiguous-chunks kill takes the continue path, which records no attempt"
echo "by design, so the proof empties each orphan's chunks (lost tail flushes)"
echo "while the worker is down. The scan then retries each fresh with attempts=1"
echo "before the redrive, and the fresh chunks land 0..M contiguous per turn."
echo "Committed burst turns have no ledger rows and keep their chunks; the"
echo "reference turn is untouched for the same reason."
REF_TURN="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/reference-turn.json','utf8')).turnId")"
if [ ! -f "${OUT}/orphans.txt" ]; then
  echo "RED assert-surgery: orphans.txt missing from the kill rounds"
  exit 1
fi
for t in $(cat "${OUT}/orphans.txt"); do
  echo "orphan chunks: $(sqlite3 "${SQLITE}" "SELECT COUNT(*) FROM pi_chunks WHERE sid = '${SID}' AND turnId = '${t}';") rows under ${t}"
  sqlite3 "${SQLITE}" "DELETE FROM pi_chunks WHERE sid = '${SID}' AND turnId = '${t}';" || exit 1
  LEFT="$(sqlite3 "${SQLITE}" "SELECT COUNT(*) FROM pi_chunks WHERE sid = '${SID}' AND turnId = '${t}';")"
  if [ "${LEFT}" != "0" ]; then
    echo "RED assert-surgery: chunk delete did not take for ${t} (left ${LEFT})"
    exit 1
  fi
done
STILL="$(sqlite3 "${SQLITE}" "SELECT COUNT(*) FROM pi_chunks WHERE sid = '${SID}' AND turnId = '${REF_TURN}';")"
echo "surgery ok: ${N_ORPHANS} orphan log(s) emptied, reference turn chunks ${STILL} (untouched)"
hook_off
echo "restarting on the same persist dir (hook disarmed: redrive runs clean)"
start_dev dev2 || exit 1
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-restart.json" || exit 1
RESTART_HEAD="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/entries-restart.json','utf8')).head")"
echo "RESTART_HEAD=${RESTART_HEAD} (only cursors above this prove post-wake work)"

echo "### 6 wait for the recovery scan: fresh post-wake result plus a latched attempt (200s)"
echo "Orphan age is two alarm periods (60s) plus the 30s scan cadence, so the"
echo "budget is 200s. Attempts are sampled every 0.5s: the scan records"
echo "attempts=1 before the fresh redrive and deletes the row on commit, so a"
echo "post-hoc query alone can never see it — the trace latch is the proof."
: > "${OUT}/attempts-trace.log"
TICK=0
RECOVERED=""
S6_START="$(date +%s)"
while [ "$(( $(date +%s) - S6_START ))" -lt 200 ]; do
  SEEN="$(sqlite3 "${SQLITE}" "SELECT COALESCE(MAX(attempts), -1) FROM pi_runs WHERE sid = '${SID}';" 2>/dev/null || echo "no-table")"
  printf 'tick=%s maxAttempts=%s\n' "${TICK}" "${SEEN}" >> "${OUT}/attempts-trace.log"
  if [ "$((TICK % 4))" -eq 0 ]; then
    ${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-wake.json" 2>/dev/null || true
    if RESTART_HEAD="${RESTART_HEAD}" WANT="${N_ORPHANS}" node -e "
const fs = require('node:fs');
const ref = fs.readFileSync('${OUT}/reference.txt', 'utf8');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries-wake.json', 'utf8'));
const after = Number(process.env.RESTART_HEAD);
const want = Number(process.env.WANT);
const hits = (replay.entries || []).filter((e) => e.type === 'result' && e.cursor > after && (() => { try { return JSON.parse(e.body).result === ref; } catch { return false; } })());
if (hits.length < want) process.exit(1);
fs.writeFileSync('${OUT}/recovered.json', JSON.stringify(hits.map((hit) => ({ cursor: hit.cursor, runId: (() => { try { return JSON.parse(hit.body).runId; } catch { return null; } })() }))));
" 2>/dev/null; then
      RECOVERED="yes"
      break
    fi
  fi
  TICK=$((TICK + 1))
  sleep 0.5
done
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-final.json" || exit 1
cp "${OUT}/entries-final.json" "${OUT}/entries-wake.json"
FAIL=""
if [ -z "${RECOVERED}" ]; then
  echo "RED assert-post-wake-result: fewer than ${N_ORPHANS} fresh post-wake results byte-equal to reference within 200s"
  FAIL="yes"
else
  echo "post-wake results ok: $(node -p "require('${OUT}/recovered.json').length") of ${N_ORPHANS} byte-equal reference"
fi

echo "### 7 re-verify the persisted sqlite holding this session"
if [ -z "${SQLITE}" ] || [ ! -f "${SQLITE}" ]; then
  echo "RED assert-sqlite: persisted sqlite lost after restart"
  FAIL="yes"
  SQLITE=""
else
  echo "sqlite ok: ${SQLITE}"
  sqlite3 "${SQLITE}" "SELECT tbl_name FROM sqlite_master WHERE type='table' AND tbl_name LIKE 'pi_%' ORDER BY 1;" > "${OUT}/tables.txt"
  cat "${OUT}/tables.txt"
fi
echo "### 8 chunk seqs contiguous per turnId"
if [ -n "${SQLITE}" ]; then
  sqlite3 "${SQLITE}" "SELECT turnId, COUNT(*) AS c, MIN(seq) AS mn, MAX(seq) AS mx FROM pi_chunks WHERE sid = '${SID}' GROUP BY turnId;" > "${OUT}/chunks.txt"
  cat "${OUT}/chunks.txt"
  node -e "
const fs = require('node:fs');
const lines = fs.readFileSync('${OUT}/chunks.txt', 'utf8').split('\n').filter((l) => l.trim().length > 0);
if (lines.length === 0) throw new Error('no pi_chunks rows for sid ${SID}');
for (const line of lines) {
  const [turnId, c, mn, mx] = line.split('|');
  if (!(Number(c) === Number(mx) + 1 && Number(mn) === 0)) {
    throw new Error('chunk seq gap for turn ' + turnId + ': ' + line);
  }
}
console.log('chunks ok: ' + lines.length + ' turn(s), every seq 0..N contiguous');
" || { echo "RED assert-chunks-contiguous: see ${OUT}/chunks.txt"; FAIL="yes"; }
else
  echo "RED assert-chunks-contiguous: no sqlite to check"
  FAIL="yes"
fi

echo "### 9 attempts recorded on the retried turn (latched trace or surviving row)"
echo "The scan records attempts=1 before the fresh redrive and deletes the row"
echo "on commit, so green normally shows the attempt only in the trace latch;"
echo "a surviving row with attempts>=1 covers failure and poison futures."
LATCHED="-1"
if [ -f "${OUT}/attempts-trace.log" ]; then
  LATCHED="$(node -p "
const fs = require('node:fs');
const lines = fs.readFileSync('${OUT}/attempts-trace.log', 'utf8').split('\n');
let m = -1;
for (const l of lines) {
  const mm = l.match(/maxAttempts=(\d+)/);
  if (mm && Number(mm[1]) > m) m = Number(mm[1]);
}
String(m);
")"
  echo "latched max attempts during wait: ${LATCHED}"
  grep -h "maxAttempts=[1-9]" "${OUT}/attempts-trace.log" | head -3 || true
fi
if [ -n "${SQLITE}" ]; then
  if sqlite3 "${SQLITE}" "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_runs';" 2>/dev/null | grep -q pi_runs; then
    sqlite3 "${SQLITE}" "SELECT turnId, attempts FROM pi_runs WHERE sid = '${SID}';" > "${OUT}/runs.txt"
    cat "${OUT}/runs.txt"
  else
    echo "(no pi_runs table post-wait)"
    : > "${OUT}/runs.txt"
  fi
else
  echo "RED assert-attempts: no sqlite to check"
  FAIL="yes"
fi
SURVIVING="-1"
if [ -f "${OUT}/runs.txt" ]; then
  SURVIVING="$(node -p "
const fs = require('node:fs');
const lines = fs.readFileSync('${OUT}/runs.txt', 'utf8').split('\n').filter((l) => l.trim().length > 0);
const nums = lines.map((l) => Number(l.split('|')[1])).filter((n) => Number.isInteger(n));
(nums.length === 0 ? -1 : Math.max(...nums));
")"
fi
if [ "${SURVIVING}" != "-1" ] && [ "${SURVIVING}" -ge 1 ] 2>/dev/null; then
  echo "attempts ok: surviving pi_runs row with attempts ${SURVIVING}"
elif [ "${LATCHED}" != "-1" ] && [ "${LATCHED}" -ge 1 ] 2>/dev/null; then
  echo "attempts ok: latched attempts=${LATCHED} during the wait (row since committed and deleted)"
else
  echo "RED assert-attempts: no latched or surviving attempt (scan never redrove)"
  FAIL="yes"
fi

echo "### 10 byte-exact reference match plus gapless replay (no duplicated commit)"
if [ -n "${RECOVERED}" ]; then
  node -e "
const fs = require('node:fs');
const ref = fs.readFileSync('${OUT}/reference.txt', 'utf8');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries-final.json', 'utf8'));
const after = Number('${RESTART_HEAD}');
const want = Number('${N_ORPHANS}');
const hits = replay.entries.filter((e) => e.type === 'result' && e.cursor > after && (() => { try { return JSON.parse(e.body).result === ref; } catch { return false; } })());
if (hits.length < want) throw new Error('only ' + hits.length + ' of ' + want + ' recovered results in the final replay');
fs.writeFileSync('${OUT}/got.txt', JSON.parse(hits[0].body).result);
console.log(hits.length + ' recovered results at cursors ' + hits.map((h) => h.cursor).join(',') + ' match reference in replay');
" || { echo "RED assert-byte-exact: recovered results mismatch"; FAIL="yes"; }
  if ! cmp -s "${OUT}/reference.txt" "${OUT}/got.txt"; then
    echo "RED assert-byte-exact: got.txt differs from reference.txt"
    FAIL="yes"
  else
    echo "byte-exact ok: got.txt cmp-equals reference.txt"
  fi
else
  echo "RED assert-byte-exact: nothing recovered to compare"
  FAIL="yes"
fi
node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries-final.json', 'utf8'));
const cursors = replay.entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i + ': suffix merge duplicated a committed entry');
}
if (cursors.length > 0 && cursors[0] !== 1) throw new Error('replay must start at cursor 1');
console.log('replay ok: ' + cursors.length + ' entries gapless from 1..' + (cursors[cursors.length - 1] || 0));
" || { echo "RED assert-gapless: cursor gap or duplicate"; FAIL="yes"; }

if [ -n "${FAIL}" ]; then
  echo "sigkill-e2e red: at least one assert above tripped; evidence in ${OUT}"
  exit 1
fi

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
echo "GROUP-DONE $(date +%s) $$" >> "${OUT}/cleanup.log"
} 2>&1 | tee "${OUT}/transcript.txt"
echo "MAIN-RESUME $(date +%s) $$" >> "${OUT}/cleanup.log"
if grep -qm1 "^PASS" "${OUT}/transcript.txt"; then
  exit 0
else
  exit 1
fi
