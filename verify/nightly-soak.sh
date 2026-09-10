#!/bin/sh
# nightly-soak.sh — Wave 4 durability soak: 100 stub turns hold overnight shape.
# Four phases of 25 fenceless WS streaming stub turns ("read seed.txt") on one
# session, a kill -9 plus restart after each of the first three phases (3
# kills total), forced `compact` between phases, then durability asserts.
# Kills race a live burst: the client chains 25 prompts on one socket and the
# script fires kill -9 once 12 dones land, so the dead server normally holds
# a mid-stream orphan (prompt committed, contiguous chunk prefix, no terminal
# delta). No sqlite surgery, no chaos hook: recovery takes only natural paths
# (continue redrives, plus zero-suffix closes when the kill lands past the
# commit). Headless `run` turns are deliberately NOT used: they commit nothing
# until done, so a mid-turn kill would orphan a prompt-less row the scan can
# only poison, and they write no chunk rows for the contiguity proof.
# Per-kill accounting is exact: cold orphans are classified from their chunk
# rows (close vs continue vs retry) to predict G new results, the wait demands
# exactly G, and the post-restart burst sends exactly 25 - D - K prompts
# (D results already past the phase head, K orphans redriven server-side), so
# every phase lands exactly 25 results with no rerun of a recovered prompt.
# Storage census is read against a measured 25-turn baseline: a scratch boot
# runs 25 uninterrupted turns plus compact, records sqlite bytes and archive
# pages/total, then the persist dir is wiped and the soak boots identical
# state. The archive grows linearly by construction (every entry archived
# exactly once), so the flatness bound is 2x of the LINEAR PROJECTION of the
# baseline (x4 for 100 turns): a leak (unreaped chunks, surviving ledger rows,
# duplicated redrives) breaks linearity beyond 2x, while healthy per-turn
# costs match the baseline almost exactly.
# Attempts are sampled every 2s during each recovery wait into
# attempts-trace.log. Continue/close paths record no attempt by design, so the
# latch is normally all zeros; any latched attempts>0 must show backoff
# (nextRunAt > updatedAt) or assert-attempts-consistent trips.
# Budgets: stub streaming turns are ~0.2s, so 100 turns cost under a minute;
# kills plus reboots dominate (orphan age 60s plus 30s scan cadence per
# recovery wait, capped at 240s). Whole script timeboxes under 30 minutes
# wall: a 1700s mid-run watchdog plus a final assert-timebox.
# Owns its worker: boots a private `wrangler dev` on the BASE port with a
# scratch --persist-to dir (default :8794, never :8787 shared dev), so it must
# NOT run against a shared server. Battery shape is kept so fast-battery can
# adopt it later: one optional BASE arg, artifacts/RUN_ID/nightly-soak/, a
# single PASS line, exit 1 otherwise.
# RED states name the tripped assert with evidence: assert-burst-stall (client
# wedged), assert-recovery-settle (orphans unrecovered in 240s),
# assert-recovery-paths (new results mismatch the cold prediction: a
# duplicated or lost redrive), assert-phase-count, assert-turn-count (not
# exactly 100 byte-equal results), assert-gapless (cursor dup or hole across
# live plus archive), assert-no-runs, assert-no-poison, assert-census-flat,
# assert-chunks-contiguous, assert-attempts-consistent, assert-timebox.
# Usage: sh verify/nightly-soak.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/nightly-soak/.
set -u
BASE="${1:-http://127.0.0.1:8794}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/nightly-soak"
mkdir -p "${OUT}"
PORT="$(printf '%s' "${BASE}" | sed -n 's/^.*:\([0-9][0-9]*\)\/*$/\1/p')"
if [ -z "${PORT}" ]; then PORT="8794"; fi
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/nightly-soak-XXXXXX")"
PIDFILE="${TMPBASE}/dev.pid"
DEV_VARS="${ROOT}/worker/.dev.vars"
PREV_VARS="${TMPBASE}/prev-dev-vars"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
SEED_BODY="seeded-body-${RUN_ID}"
PROMPT="read seed.txt"
PHASE_N=25
TOTAL_TURNS=100
KILL_AT_DONES=12
WAIT_BUDGET_S=240
WALL_BUDGET_S=1800
WALL_WATCHDOG_S=1700
START_T="$(date +%s)"
elapsed() { printf '%s' "$(( $(date +%s) - START_T ))"; }
past_watchdog() { [ "$(elapsed)" -gt "${WALL_WATCHDOG_S}" ]; }

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
      echo "port ${PORT} still serves traffic after 30s; expected it free (fresh boot: pass a free BASE, default http://127.0.0.1:8794; restart: the kill -9 did not land)"
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
find_sqlite() {
  # Prints the persisted sqlite file holding this session's entries, if any.
  sid="$1"
  for f in $(find "${TMPBASE}" -name "*.sqlite" 2>/dev/null); do
    if sqlite3 "${f}" "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_entries';" 2>/dev/null | grep -q pi_entries; then
      if sqlite3 "${f}" "SELECT 1 FROM pi_entries WHERE sid = '${sid}' LIMIT 1;" 2>/dev/null | grep -q 1; then
        printf '%s' "${f}"
        return 0
      fi
    fi
  done
  return 1
}
sqlite_bytes() {
  # File bytes backing one sqlite database (main file plus any wal/shm).
  db="$1"
  total=0
  for g in "${db}" "${db}-wal" "${db}-shm"; do
    if [ -f "${g}" ]; then
      b="$(wc -c < "${g}" | tr -d ' ')"
      total=$((total + b))
    fi
  done
  printf '%s' "${total}"
}
results_since() {
  # Total result entries with cursor above FLOOR across live plus archive.
  # Live-only counting goes stale the moment a compaction archives phase
  # results, so every phase accountant reads both. $4 = evidence tag.
  ws="$1"
  sid="$2"
  floor="$3"
  tag="$4"
  ${CLI} entries --ws "${ws}" --sid "${sid}" --after "${floor}" --limit 1000 --base "${BASE}" --json > "${OUT}/live-${tag}.json" 2>/dev/null || return 1
  ${CLI} meta --ws "${ws}" --sid "${sid}" --base "${BASE}" --json > "${OUT}/meta-${tag}.json" 2>/dev/null || return 1
  PG="$(node -p "require('${OUT}/meta-${tag}.json').compaction.archivePages")" || return 1
  PP=1
  while [ "${PP}" -le "${PG}" ]; do
    ${CLI} archive --ws "${ws}" --sid "${sid}" --page "${PP}" --base "${BASE}" --json > "${OUT}/archive-${tag}-p-${PP}.json" 2>/dev/null || return 1
    PP=$((PP + 1))
  done
  OUT="${OUT}" TAG="${tag}" FLOOR="${floor}" PAGES="${PG}" node -e "
const fs = require('node:fs');
const out = process.env.OUT;
const tag = process.env.TAG;
const floor = Number(process.env.FLOOR);
const pages = Number(process.env.PAGES);
let n = 0;
for (const e of JSON.parse(fs.readFileSync(out + '/live-' + tag + '.json', 'utf8')).entries) {
  if (e.type === 'result' && e.cursor > floor) n += 1;
}
for (let p = 1; p <= pages; p++) {
  for (const e of JSON.parse(fs.readFileSync(out + '/archive-' + tag + '-p-' + p + '.json', 'utf8')).entries) {
    if (e.type === 'result' && e.cursor > floor) n += 1;
  }
}
console.log(n);
" || return 1
}
head_now() {
  ws="$1"
  sid="$2"
  ${CLI} entries --ws "${ws}" --sid "${sid}" --after 0 --limit 1 --base "${BASE}" --json 2>/dev/null | node -p "JSON.parse(require('node:fs').readFileSync(0,'utf8')).head"
}
dones_in() {
  # Count done frames in a client snapshot. Snapshots are compact JSON
  # (the whole burst on a few lines), so count occurrences via grep -o,
  # never matching lines via grep -c. Matches '"done":' with any spacing.
  n="$(grep -o '"done":' "$1" 2>/dev/null | wc -l | tr -d ' ')"
  case "${n}" in ''|*[!0-9]*) printf '0';; *) printf '%s' "${n}";; esac
}
reap_client() {
  # The server is dead, so the burst socket must close out; reap it, else
  # force it. $1 = client pid.
  j=0
  while kill -0 "$1" 2>/dev/null; do
    j=$((j + 1))
    if [ "${j}" -ge 150 ]; then
      kill -KILL "$1" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done
  wait "$1" 2>/dev/null || true
}
assert_down_stable() {
  # The kill must leave the server down and stable: a supervisor that
  # re-arms behind us would complete turns invisibly and forge recovery.
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
  # No ghost may survive with a parked turn inside it: a runtime orphaned
  # by a pattern-only sweep keeps the sqlite FD and completes the turn
  # invisibly, forging the recovery. Any pre-kill workerd still alive now
  # fails loudly instead.
  GHOSTS=""
  for p in $(cat "$1" 2>/dev/null); do
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
  echo "server down and stable after kill -9"
  return 0
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
start_dev dev0 || exit 1

echo "### 1 write the node WS client (global WebSocket, zero deps, fenceless)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
// Burst mode chains COUNT sequential turns on one socket (each done frame
// triggers the next prompt) with no fence rotation (legacy path), so a
// mid-burst kill always holds exactly one in-flight turn and unsent prompts
// never existed server-side.
const COUNT = Number(process.env.COUNT || "1");
let sent = 0;
let dones = 0;
function sendPrompt() {
  sent += 1;
  sock.send(JSON.stringify({ prompt: PROMPT }));
}
import { writeFileSync } from "node:fs";

const frames = [];
let close = null;
let settled = false;
let sentAt = 0;
function snapshot() {
  try {
    writeFileSync(OUTFILE, JSON.stringify({ frames, close, sentAt, sent, dones }));
  } catch {
    // The polled file may race the kill; the next frame rewrites it.
  }
}
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    writeFileSync(OUTFILE, JSON.stringify({ frames, close, sentAt, sent, dones, note: note || null }));
  } catch {
    // Best effort after kill -9; the frames already snapshotted stand.
  }
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 300000);
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
    if (dones >= COUNT) {
      // Every chained prompt is answered: close only on the final done.
      // (Closing on any post-COUNT frame would drop the last turn: its
      // entry frames arrive after the final prompt was sent.)
      try {
        sock.close(1000, "client done");
      } catch {
        // Already closing; the fallback below still records the frames.
      }
      setTimeout(() => finish(0, "all dones received; closed"), 1000);
      return;
    }
    if (sent < COUNT) {
      sendPrompt();
      return;
    }
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

echo "### 2 baseline: 25 uninterrupted turns plus compact, record the census"
WS0_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WS0="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS0_JSON}")"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS0}" --path "seed.txt" --base "${BASE}" --json || exit 1
BS_JSON="$(${CLI} session create --ws "${WS0}" --base "${BASE}" --json)" || exit 1
BSID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${BS_JSON}")"
echo "baseline ws=${WS0} sid=${BSID}"
WS_URL="${WS_BASE}/workspaces/${WS0}/sessions/${BSID}/stream" COUNT="${PHASE_N}" PROMPT="${PROMPT}" OUTFILE="${OUT}/frames-base.json" node "${OUT}/ws-client.mjs" >>"${OUT}/client-base.log" 2>&1 &
BBPID=$!
BW=0
while [ "${BW}" -lt 2400 ]; do
  BDONES="$(dones_in "${OUT}/frames-base.json")"
  if [ "${BDONES}" -ge "${PHASE_N}" ]; then break; fi
  if ! kill -0 "${BBPID}" 2>/dev/null; then break; fi
  BW=$((BW + 1))
  sleep 0.05
done
wait "${BBPID}" 2>/dev/null || true
BDONES="$(dones_in "${OUT}/frames-base.json")"
if [ "${BDONES}" != "${PHASE_N}" ]; then
  echo "RED assert-baseline: only ${BDONES} of ${PHASE_N} baseline dones (see ${OUT}/client-base.log)"
  exit 1
fi
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-base.json', 'utf8'));
const dones = b.frames.filter((f) => f.done === true);
if (dones.length !== ${PHASE_N}) throw new Error('want ${PHASE_N} dones, got ' + dones.length);
for (const d of dones) {
  if (!d.turnId || typeof d.turnId !== 'string') throw new Error('done must carry turnId');
  if (!d.runtime || d.runtime.provider !== 'stub' || d.runtime.model !== 'stub') throw new Error('keyless stub only');
}
const ref = dones[0].result;
for (const d of dones) {
  if (d.result !== ref) throw new Error('stub must be deterministic across baseline turns');
}
fs.writeFileSync('${OUT}/reference.txt', String(ref));
console.log('baseline ok: ${PHASE_N} stub dones, reference ' + String(ref).length + ' bytes');
" || exit 1
${CLI} compact --ws "${WS0}" --sid "${BSID}" --base "${BASE}" --json > "${OUT}/compact-base.json" || exit 1
${CLI} meta --ws "${WS0}" --sid "${BSID}" --base "${BASE}" --json > "${OUT}/meta-base.json" || exit 1
BSQLITE="$(find_sqlite "${BSID}")" || { echo "RED assert-baseline: no persisted sqlite holds baseline sid ${BSID}"; exit 1; }
B0="$(sqlite_bytes "${BSQLITE}")"
P0="$(node -p "require('${OUT}/meta-base.json').compaction.archivePages")"
T0="$(node -p "require('${OUT}/meta-base.json').compaction.archiveTotal")"
LIVE0="$(node -p "require('${OUT}/meta-base.json').count")"
node -e "
const fs = require('node:fs');
const c = require('${OUT}/compact-base.json');
if (!c.compacted) throw new Error('baseline compact must archive (live 150 expected), got ' + JSON.stringify(c));
fs.writeFileSync('${OUT}/baseline.json', JSON.stringify({ bytes: Number('${B0}'), pages: Number('${P0}'), total: Number('${T0}'), live: Number('${LIVE0}') }));
console.log('baseline census: bytes=${B0} pages=${P0} total=${T0} live=${LIVE0}');
" || exit 1
if [ "${P0}" -lt 1 ]; then
  echo "RED assert-baseline: baseline archived zero pages (census projection needs pages>=1)"
  exit 1
fi

echo "### 3 wipe persist and reboot: the soak starts from identical state"
stop_dev
rm -rf "${TMPBASE}/persist"
start_dev dev1 || exit 1

echo "### 4 soak session: 4 phases of ${PHASE_N} turns, kills after phases 1-3"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "soak ws=${WS} sid=${SID}"
H_S0="$(head_now "${WS}" "${SID}")" || exit 1
echo "H_S0=${H_S0}"
KILLS=0
ORPHANS_TOTAL=0
: > "${OUT}/attempts-trace.log"
PH=1
while [ "${PH}" -le 4 ]; do
  if past_watchdog; then
    echo "RED assert-timebox: past the ${WALL_WATCHDOG_S}s watchdog before phase ${PH} (elapsed $(elapsed)s)"
    exit 1
  fi
  echo "--- phase ${PH}"
  H0="$(head_now "${WS}" "${SID}")" || exit 1
  echo "phase ${PH} H0=${H0}"
  if [ "${PH}" -le 3 ]; then
    KILLFILE="${OUT}/frames-phase-${PH}.json"
    rm -f "${KILLFILE}"
    WS_URL="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream" COUNT="${PHASE_N}" PROMPT="${PROMPT}" OUTFILE="${KILLFILE}" node "${OUT}/ws-client.mjs" >>"${OUT}/client-phase-${PH}.log" 2>&1 &
    CLIENTPID=$!
    FIRED=""
    W=0
    while [ "${W}" -lt 2400 ]; do
      DONES="$(dones_in "${KILLFILE}")"
      if [ "${DONES}" -ge "${KILL_AT_DONES}" ]; then FIRED="midburst"; break; fi
      if [ "${DONES}" -ge "${PHASE_N}" ]; then FIRED="burst-done"; break; fi
      if ! kill -0 "${CLIENTPID}" 2>/dev/null; then FIRED="client-exit"; break; fi
      W=$((W + 1))
      sleep 0.05
    done
    if [ -z "${FIRED}" ]; then
      echo "RED assert-burst-stall: phase ${PH} burst made no killable progress in 120s (see ${OUT}/client-phase-${PH}.log)"
      kill -KILL "${CLIENTPID}" 2>/dev/null || true
      exit 1
    fi
    if [ "${FIRED}" = "client-exit" ]; then
      DONES="$(dones_in "${KILLFILE}")"
      echo "RED assert-burst-died: phase ${PH} burst client exited with ${DONES} of ${PHASE_N} dones (see ${OUT}/client-phase-${PH}.log)"
      exit 1
    fi
    echo "firing kill -9 (${FIRED}, dones ${DONES} of ${PHASE_N})"
    H_PRE="$(head_now "${WS}" "${SID}" 2>/dev/null || echo '?')"
    echo "H_PRE=${H_PRE}"
    pgrep -f 'workerd.*serve' 2>/dev/null | sort -n > "${OUT}/workerd-before-${PH}.txt" || true
    kill9_port
    reap_client "${CLIENTPID}"
    assert_down_stable "${OUT}/workerd-before-${PH}.txt" || exit 1
    echo "disconnect observed and stable; the persist dir is cold"
    SQLITE="$(find_sqlite "${SID}")" || { echo "RED assert-sqlite: no persisted sqlite holds sid ${SID} after kill ${PH}"; exit 1; }
    echo "sqlite ok: ${SQLITE}"
    sqlite3 "${SQLITE}" "SELECT turnId FROM pi_runs WHERE sid = '${SID}';" > "${OUT}/orphans-phase-${PH}.txt" || exit 1
    N_ORPHANS="$(grep -c . "${OUT}/orphans-phase-${PH}.txt" 2>/dev/null || true)"
    case "${N_ORPHANS}" in ''|*[!0-9]*) N_ORPHANS=0;; esac
    echo "cold orphans: ${N_ORPHANS}"
    ORPHANS_TOTAL=$((ORPHANS_TOTAL + N_ORPHANS))
    # Cold classification: contiguous chunk rows predict continue, a
    # terminal prefix (result/error already committed) predicts a
    # zero-suffix close, anything else predicts retry. Continues and
    # retries each add exactly one new result; closes add none.
    for t in $(cat "${OUT}/orphans-phase-${PH}.txt"); do
      sqlite3 -json "${SQLITE}" "SELECT seq, body FROM pi_chunks WHERE sid = '${SID}' AND turnId = '${t}' ORDER BY seq ASC;" > "${OUT}/chunks-phase-${PH}-${t}.json" || exit 1
    done
    ORPHAN_CSV="$(tr '\n' ' ' < "${OUT}/orphans-phase-${PH}.txt" | sed 's/ $//;s/ /,/g')"
    OUT="${OUT}" PH="${PH}" ORPHANS="${ORPHAN_CSV}" node -e "
const fs = require('node:fs');
const out = process.env.OUT;
const ph = process.env.PH;
const ids = process.env.ORPHANS === '' ? [] : process.env.ORPHANS.split(',');
let closes = 0;
let redrives = 0;
const detail = [];
for (const id of ids) {
  const rows = JSON.parse(fs.readFileSync(out + '/chunks-phase-' + ph + '-' + id + '.json', 'utf8'));
  const seqs = rows.map((r) => r.seq);
  let contiguous = rows.length > 0;
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i) { contiguous = false; break; }
  }
  let terminal = false;
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.body);
      if (obj !== null && typeof obj === 'object' && (typeof obj.result === 'string' || typeof obj.error === 'string')) { terminal = true; break; }
    } catch { continue; }
  }
  const path = terminal && contiguous ? 'close' : (contiguous ? 'continue' : 'retry');
  if (path === 'close') closes += 1; else redrives += 1;
  detail.push(id + ' chunks=' + rows.length + ' contiguous=' + contiguous + ' terminal=' + terminal + ' path=' + path);
}
fs.writeFileSync(out + '/classify-phase-' + ph + '.txt', detail.join('\n') + '\n');
fs.writeFileSync(out + '/classify-phase-' + ph + '.json', JSON.stringify({ orphans: ids.length, closes, redrives, predicted: redrives }));
console.log('cold prediction: ' + ids.length + ' orphan(s): ' + closes + ' close(s), ' + redrives + ' redrive(s), expect ' + redrives + ' new result(s)');
" || exit 1
    cat "${OUT}/classify-phase-${PH}.txt"
    K_PRED="$(node -p "require('${OUT}/classify-phase-${PH}.json').predicted")"
    echo "restarting on the same persist dir"
    start_dev "dev-phase-${PH}" || exit 1
D_PRE="$(results_since "${WS}" "${SID}" "${H0}" "prestart-${PH}")" || { echo "RED assert-entries: phase ${PH} pre-restart replay unreadable"; exit 1; }
echo "D_PRE=${D_PRE} (results past phase head already committed pre-kill)"
N_POST=$((PHASE_N - D_PRE - K_PRED))
if [ "${N_POST}" -lt 0 ]; then
  echo "RED assert-recovery-paths: phase ${PH} over-committed (D_PRE=${D_PRE} plus predicted ${K_PRED} exceeds ${PHASE_N})"
  exit 1
fi
echo "N_POST=${N_POST} prompts remain for the post-restart burst"
# Recovery wait: rows must drain and exactly the predicted NEW results must
# land (totals minus D_PRE). Attempts latch sampled every 2s: rows only
# vanish via commit-delete (a result lands) or backoff-visible attempts.
S6_START="$(date +%s)"
TICK=0
SETTLED=""
TOT="${D_PRE}"
NEW=0
while [ "$(( $(date +%s) - S6_START ))" -lt "${WAIT_BUDGET_S}" ]; do
  RUNS="$(sqlite3 "${SQLITE}" "SELECT turnId || '|' || attempts || '|' || nextRunAt || '|' || updatedAt FROM pi_runs WHERE sid = '${SID}';" 2>/dev/null || echo "no-table")"
  H_CUR="$(head_now "${WS}" "${SID}" 2>/dev/null || echo '?')"
  if [ -n "${RUNS}" ] && [ "${RUNS}" != "no-table" ]; then
    DRAINED=""
  else
    DRAINED="yes"
  fi
  # Cheap latch ticks stay on the 2s cadence; the heavier replay census
  # (entries plus meta plus every archive page) refreshes every 5th tick
  # and on every drained tick, where the settle decision needs it fresh.
  if [ -n "${DRAINED}" ] || [ "$((TICK % 5))" -eq 0 ]; then
    TOT="$(results_since "${WS}" "${SID}" "${H0}" "wait-${PH}" 2>/dev/null || echo '?')"
    case "${TOT}" in
      ''|*[!0-9]*) NEW='?' ;;
      *) NEW=$((TOT - D_PRE)) ;;
    esac
  fi
  printf 'phase=%s t=%s head=%s results=%s runs=%s\n' "${PH}" "${TICK}" "${H_CUR}" "${TOT}" "$(printf '%s' "${RUNS}" | tr '\n' ';')" >> "${OUT}/attempts-trace.log"
  if [ -z "${DRAINED}" ]; then
    TICK=$((TICK + 1))
    sleep 2
    continue
  fi
  # No surviving rows: settle once the predicted new results are in.
  if [ "${NEW}" = "${K_PRED}" ]; then
    SETTLED="yes"
    break
  fi
  TICK=$((TICK + 1))
  sleep 2
done
TOT_END="$(results_since "${WS}" "${SID}" "${H0}" "wait-${PH}" 2>/dev/null || echo '?')"
case "${TOT_END}" in
  ''|*[!0-9]*) NEW_END='?' ;;
  *) NEW_END=$((TOT_END - D_PRE)) ;;
esac
if [ -z "${SETTLED}" ]; then
  echo "RED assert-recovery-settle: phase ${PH} orphans unrecovered in ${WAIT_BUDGET_S}s (want ${K_PRED} new results, got new=${NEW_END} total=${TOT_END} D_PRE=${D_PRE}; trace in ${OUT}/attempts-trace.log)"
  exit 1
fi
if [ "${NEW_END}" != "${K_PRED}" ]; then
  echo "RED assert-recovery-paths: phase ${PH} prediction mismatch (cold predicted ${K_PRED} new results, replay shows new=${NEW_END})"
  exit 1
fi
echo "recovery ok: ${NEW_END} new result(s) for ${N_ORPHANS} orphan(s), rows drained"
    if [ "${N_POST}" -gt 0 ]; then
      POSTFILE="${OUT}/frames-post-${PH}.json"
      rm -f "${POSTFILE}"
      WS_URL="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream" COUNT="${N_POST}" PROMPT="${PROMPT}" OUTFILE="${POSTFILE}" node "${OUT}/ws-client.mjs" >>"${OUT}/client-post-${PH}.log" 2>&1 &
      POSTPID=$!
      PW=0
      while [ "${PW}" -lt 2400 ]; do
        PDONES="$(dones_in "${POSTFILE}")"
        if [ "${PDONES}" -ge "${N_POST}" ]; then break; fi
        if ! kill -0 "${POSTPID}" 2>/dev/null; then break; fi
        PW=$((PW + 1))
        sleep 0.05
      done
      wait "${POSTPID}" 2>/dev/null || true
      PDONES="$(dones_in "${POSTFILE}")"
      if [ "${PDONES}" != "${N_POST}" ]; then
        echo "RED assert-post-burst: phase ${PH} post-restart burst gave ${PDONES} of ${N_POST} dones (see ${OUT}/client-post-${PH}.log)"
        exit 1
      fi
      echo "post-restart burst ok: ${PDONES} dones"
    else
      echo "post-restart burst skipped (phase already complete via recovery)"
    fi
    KILLS=$((KILLS + 1))
  else
    WS_URL="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream" COUNT="${PHASE_N}" PROMPT="${PROMPT}" OUTFILE="${OUT}/frames-phase-${PH}.json" node "${OUT}/ws-client.mjs" >>"${OUT}/client-phase-${PH}.log" 2>&1 &
    CLIENTPID=$!
    FW=0
    while [ "${FW}" -lt 2400 ]; do
      DONES="$(dones_in "${OUT}/frames-phase-${PH}.json")"
      if [ "${DONES}" -ge "${PHASE_N}" ]; then break; fi
      if ! kill -0 "${CLIENTPID}" 2>/dev/null; then break; fi
      FW=$((FW + 1))
      sleep 0.05
    done
    wait "${CLIENTPID}" 2>/dev/null || true
    DONES="$(dones_in "${OUT}/frames-phase-${PH}.json")"
    if [ "${DONES}" != "${PHASE_N}" ]; then
      echo "RED assert-phase-burst: phase ${PH} uninterrupted burst gave ${DONES} of ${PHASE_N} dones (see ${OUT}/client-phase-${PH}.log)"
      exit 1
    fi
    echo "phase ${PH} burst ok: ${DONES} dones"
  fi
  R_CUM="$(results_since "${WS}" "${SID}" "${H_S0}" "cum-${PH}")" || { echo "RED assert-entries: phase ${PH} cumulative replay unreadable"; exit 1; }
  WANT_CUM=$((PH * PHASE_N))
  if [ "${R_CUM}" != "${WANT_CUM}" ]; then
    echo "RED assert-phase-count: phase ${PH} cumulative results ${R_CUM}, want ${WANT_CUM}"
    exit 1
  fi
  echo "phase ${PH} cumulative results ok: ${R_CUM} of ${TOTAL_TURNS}"
  ${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/compact-phase-${PH}.json" || exit 1
  node -e "
const c = require('${OUT}/compact-phase-${PH}.json');
console.log('forced compact after phase ${PH}: compacted=' + c.compacted + ' live=' + c.live + ' archived=' + c.archived + ' pages=' + c.pages);
" || exit 1
  PH=$((PH + 1))
done
if [ "${KILLS}" != "3" ]; then
  echo "RED assert-kill-count: only ${KILLS} kill-restart cycles, want 3"
  exit 1
fi
echo "kills ok: ${KILLS} kill-restart cycles, ${ORPHANS_TOTAL} cold orphan(s) total"

echo "### 5 final compact plus full evidence"
${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/compact-final.json" || exit 1
sleep 5
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --all --base "${BASE}" --json > "${OUT}/entries-final.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-final.json" || exit 1
SQLITE="$(find_sqlite "${SID}")" || { echo "RED assert-sqlite: persisted sqlite lost after the soak"; exit 1; }
PAGES="$(node -p "require('${OUT}/meta-final.json').compaction.archivePages")"
P=1
while [ "${P}" -le "${PAGES}" ]; do
  ${CLI} archive --ws "${WS}" --sid "${SID}" --page "${P}" --base "${BASE}" --json > "${OUT}/archive-p-${P}.json" || exit 1
  P=$((P + 1))
done
B1="$(sqlite_bytes "${SQLITE}")"
T1="$(node -p "require('${OUT}/meta-final.json').compaction.archiveTotal")"
LIVE1="$(node -p "require('${OUT}/meta-final.json').count")"
HEAD1="$(node -p "require('${OUT}/meta-final.json').head")"
node -e "
const b = require('${OUT}/baseline.json');
const proj = { bytes: b.bytes * 4, pages: b.pages * 4, total: b.total * 4 };
const fin = { bytes: Number('${B1}'), pages: Number('${PAGES}'), total: Number('${T1}'), live: Number('${LIVE1}'), head: Number('${HEAD1}') };
require('node:fs').writeFileSync('${OUT}/census.json', JSON.stringify({ baseline: b, projection4x: proj, final: fin }, null, 2));
console.log('census: baseline bytes=' + b.bytes + ' pages=' + b.pages + ' total=' + b.total + ' live=' + b.live);
console.log('census: final bytes=' + fin.bytes + ' pages=' + fin.pages + ' total=' + fin.total + ' live=' + fin.live + ' head=' + fin.head);
" || exit 1
sqlite3 "${SQLITE}" "SELECT turnId, COUNT(*) AS c, MIN(seq) AS mn, MAX(seq) AS mx FROM pi_chunks WHERE sid = '${SID}' GROUP BY turnId;" > "${OUT}/chunks-final.txt"
cat "${OUT}/chunks-final.txt"
if sqlite3 "${SQLITE}" "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_runs';" 2>/dev/null | grep -q pi_runs; then
  sqlite3 "${SQLITE}" "SELECT turnId, attempts FROM pi_runs WHERE sid = '${SID}';" > "${OUT}/runs-final.txt"
  cat "${OUT}/runs-final.txt"
else
  echo "(no pi_runs table at final)"
  : > "${OUT}/runs-final.txt"
fi
EL="$(elapsed)"
echo "wall elapsed ${EL}s"

FAIL=""
echo "### 6 assert-turn-count: exactly ${TOTAL_TURNS} results, byte-equal, distinct runs"
node -e "
const fs = require('node:fs');
const ref = fs.readFileSync('${OUT}/reference.txt', 'utf8');
const live = JSON.parse(fs.readFileSync('${OUT}/entries-final.json', 'utf8')).entries;
const pages = Number('${PAGES}');
const archived = [];
for (let p = 1; p <= pages; p++) {
  archived.push(...JSON.parse(fs.readFileSync('${OUT}/archive-p-' + p + '.json', 'utf8')).entries);
}
const results = live.concat(archived).filter((e) => e.type === 'result');
if (results.length !== ${TOTAL_TURNS}) throw new Error('want ${TOTAL_TURNS} results, got ' + results.length);
const runs = new Set();
for (const r of results) {
  const body = JSON.parse(r.body);
  if (body.result !== ref) throw new Error('result at cursor ' + r.cursor + ' differs from reference');
  if (typeof body.runId !== 'string' || body.runId.length === 0) throw new Error('result at cursor ' + r.cursor + ' lacks runId');
  runs.add(body.runId);
}
if (runs.size !== ${TOTAL_TURNS}) throw new Error('want ${TOTAL_TURNS} distinct runIds, got ' + runs.size);
fs.writeFileSync('${OUT}/turn-count.json', JSON.stringify({ results: results.length, distinctRuns: runs.size }));
console.log('turns ok: ${TOTAL_TURNS} results byte-equal to reference, ${TOTAL_TURNS} distinct runIds');
" || { echo "RED assert-turn-count: see evidence in ${OUT} (entries-final.json plus archive-p-*.json)"; FAIL="yes"; }

echo "### 7 assert-gapless: live plus archive cursors cover 1..head exactly once"
node -e "
const fs = require('node:fs');
const live = JSON.parse(fs.readFileSync('${OUT}/entries-final.json', 'utf8')).entries;
const pages = Number('${PAGES}');
const archived = [];
for (let p = 1; p <= pages; p++) {
  archived.push(...JSON.parse(fs.readFileSync('${OUT}/archive-p-' + p + '.json', 'utf8')).entries);
}
const head = Number('${HEAD1}');
const seen = new Map();
for (const e of live.concat(archived)) {
  seen.set(e.cursor, (seen.get(e.cursor) || 0) + 1);
}
if (seen.size !== head) throw new Error('want ' + head + ' distinct cursors, got ' + seen.size);
for (let c = 1; c <= head; c++) {
  if (seen.get(c) !== 1) throw new Error('cursor ' + c + ' appears ' + (seen.get(c) || 0) + ' times: dup or hole');
}
console.log('replay ok: cursors 1..' + head + ' each exactly once across live plus ' + pages + ' archive page(s)');
" || { echo "RED assert-gapless: cursor dup or hole (entries-final.json plus archive-p-*.json)"; FAIL="yes"; }
echo "### 8 assert-no-runs plus assert-no-poison"
N_RUNS="$(grep -c . "${OUT}/runs-final.txt" 2>/dev/null || true)"
case "${N_RUNS}" in ''|*[!0-9]*) N_RUNS=0;; esac
if [ "${N_RUNS}" != "0" ]; then
  echo "RED assert-no-runs: ${N_RUNS} surviving pi_runs row(s) (see ${OUT}/runs-final.txt)"
  FAIL="yes"
else
  echo "runs ok: zero surviving pi_runs rows"
fi
N_POISON=0
if sqlite3 "${SQLITE}" "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_runs';" 2>/dev/null | grep -q pi_runs; then
  N_POISON="$(sqlite3 "${SQLITE}" "SELECT COUNT(*) FROM pi_runs WHERE sid = '${SID}' AND attempts >= 3;" 2>/dev/null || echo '?')"
fi
if [ "${N_POISON}" != "0" ]; then
  echo "RED assert-no-poison: ${N_POISON} poisoned row(s) at attempts>=3 (see ${OUT}/runs-final.txt)"
  FAIL="yes"
else
  echo "poison ok: zero rows at attempts>=3"
fi

echo "### 9 assert-census-flat: final within 2x of the 4x baseline projection"
node -e "
const c = require('${OUT}/census.json');
function check(name, fin, proj) {
  const bound = proj * 2;
  if (!(fin <= bound)) throw new Error(name + ': final ' + fin + ' exceeds 2x projection ' + bound + ' (projection ' + proj + ')');
  console.log(name + ' ok: final ' + fin + ' within 2x of 4x-baseline projection ' + proj + ' (bound ' + bound + ')');
}
check('sqlite bytes', c.final.bytes, c.projection4x.bytes);
check('archive pages', c.final.pages, c.projection4x.pages);
check('archive total', c.final.total, c.projection4x.total);
if (!(c.final.live <= 32)) throw new Error('live table not bounded: ' + c.final.live);
console.log('live ok: ' + c.final.live + ' rows bounded after final compact');
" || { echo "RED assert-census-flat: see ${OUT}/census.json"; FAIL="yes"; }

echo "### 10 assert-chunks-contiguous per turnId"
node -e "
const fs = require('node:fs');
const lines = fs.readFileSync('${OUT}/chunks-final.txt', 'utf8').split('\n').filter((l) => l.trim().length > 0);
if (lines.length === 0) throw new Error('no pi_chunks rows for sid ${SID}');
for (const line of lines) {
  const parts = line.split('|');
  const turnId = parts[0];
  const c = Number(parts[1]);
  const mn = Number(parts[2]);
  const mx = Number(parts[3]);
  if (!(c === mx + 1 && mn === 0)) {
    throw new Error('chunk seq gap for turn ' + turnId + ': ' + line);
  }
}
console.log('chunks ok: ' + lines.length + ' turn(s), every seq 0..N contiguous');
" || { echo "RED assert-chunks-contiguous: see ${OUT}/chunks-final.txt"; FAIL="yes"; }

echo "### 11 assert-attempts-consistent: latched attempts show backoff or nothing"
node -e "
const fs = require('node:fs');
const lines = fs.readFileSync('${OUT}/attempts-trace.log', 'utf8').split('\n').filter((l) => l.indexOf('runs=') >= 0);
let latched = 0;
const backoff = new Set();
const seen = new Map();
for (const line of lines) {
  const m = line.match(/runs=(.*)$/);
  if (!m) continue;
  const cells = m[1].split(';').filter((c) => c.length > 0 && c !== 'no-table');
  for (const cell of cells) {
    const parts = cell.split('|');
    if (parts.length < 4) continue;
    const turn = parts[0];
    const attempts = Number(parts[1]);
    const nextRunAt = Number(parts[2]);
    const updatedAt = Number(parts[3]);
    if (attempts > latched) latched = attempts;
    if (!seen.has(turn) || seen.get(turn) < attempts) seen.set(turn, attempts);
    if (attempts > 0 && nextRunAt > updatedAt) backoff.add(turn + ':' + attempts);
  }
}
for (const entry of seen) {
  const turn = entry[0];
  const attempts = entry[1];
  if (attempts > 0) {
    let visible = false;
    for (const b of backoff) {
      if (b.indexOf(turn + ':') === 0) { visible = true; break; }
    }
    if (!visible) throw new Error('turn ' + turn + ' latched attempts=' + attempts + ' with no backoff-visible sample (nextRunAt > updatedAt)');
  }
}
if (latched >= 3) throw new Error('latched attempts=' + latched + ' at the poison threshold');
fs.writeFileSync('${OUT}/attempts-latch.json', JSON.stringify({ latchedMax: latched, turnsSeen: seen.size }));
console.log('attempts ok: ' + seen.size + ' turn(s) sampled, latched max ' + latched + ' (absent or backoff-visible throughout)');
" || { echo "RED assert-attempts-consistent: see ${OUT}/attempts-trace.log"; FAIL="yes"; }

echo "### 12 assert-timebox: whole script under ${WALL_BUDGET_S}s wall"
if [ "${EL}" -ge "${WALL_BUDGET_S}" ]; then
  echo "RED assert-timebox: elapsed ${EL}s exceeds ${WALL_BUDGET_S}s"
  FAIL="yes"
else
  echo "timebox ok: ${EL}s under ${WALL_BUDGET_S}s"
fi

if [ -n "${FAIL}" ]; then
  echo "nightly-soak red: at least one assert above tripped; evidence in ${OUT}"
  exit 1
fi

LATCHED="$(node -p "require('${OUT}/attempts-latch.json').latchedMax")"
echo "PASS ${RUN_ID} turns=${TOTAL_TURNS} kills=${KILLS} orphans=${ORPHANS_TOTAL} sqlite_bytes=${B1} archive_pages=${PAGES} archive_total=${T1} latched_attempts=${LATCHED} wall=${EL}s ws=${WS} sid=${SID}"
echo "GROUP-DONE $(date +%s) $$" >> "${OUT}/cleanup.log"
} 2>&1 | tee "${OUT}/transcript.txt"
echo "MAIN-RESUME $(date +%s) $$" >> "${OUT}/cleanup.log"
if grep -qm1 "^PASS" "${OUT}/transcript.txt"; then
  exit 0
else
  exit 1
fi
