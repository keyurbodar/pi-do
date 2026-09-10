#!/bin/sh
# eviction-repro.sh — proves a mid-turn DO eviction loses the turn on current
# main behavior. It starts a slow keyed WS turn, waits until the turn is in
# flight, then waits for the eviction (socket drop), then prints the LOST
# inventory: which entry rows and deltas the turn produced (streamed frames)
# versus which rows survived in SQL after the reboot.
# Eviction method: RESTART of the dev server mid-turn (kill -9 workerd plus
# reboot on the same port with the same --persist state dir). Idle-kill was
# considered and rejected: wrangler-dev DOs expose no externally triggerable
# idle eviction while a WS turn is in flight, and the lane protocol forbids
# this lane from owning or killing the isolated server, so the restart is
# performed by the harness operator (Main) while this script holds the turn
# open and detects the drop. The script never kills anything itself.
# On current main behavior the killed turn can never complete: no result row,
# no done frame, no totals bump, the run stays open, and any uncheckpointed
# tail frames are gone. The script therefore prints a LOST headline and exits
# 1. If a future run heals all of that (same-chain resume with no missing
# rows), it prints PASS and exits 0.
# Any 429/rate/quota/provider-refusal on the keyed path writes OUT/BLOCKED
# naming the stuck turn, keeps the transcript, stops, and exits 0.
# Usage: sh verify/eviction-repro.sh [BASE] (an isolated keyed BASE, never
# the house 8787 which runs main-checkout code).
# Exit 1 with a LOST headline on current behavior, 0 on pass/heal or on a
# named quota/missing-secret block. Writes artifacts/RUN_ID/eviction-repro/.
# Wave 2 gap record (recovery scan merged; this script predates it and stays
# unextended by design): it proves produced-frames versus survived-rows plus the
# missing result/done, but covers none of the scan contract — no orphan-age wait
# (it re-reads entries right after the reboot, never past ORPHAN_AFTER_MS), no
# redrive assertion (same-chain resume shows only as healed, never as a redrive),
# and no attempts observation (the scan records attempts pre-redrive and deletes
# the row on commit, which only sigkill-e2e.sh latches). quota-refusal.sh covers
# the orphan-age-quiet half of that contract on a refused turn.
set -u
BASE="${1:-http://127.0.0.1:8791}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/eviction-repro"
mkdir -p "${OUT}"
KEYED_MODEL="opencode-go/muse-spark-1.3-contributor"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
LONG_A="Write a vivid story of at least 700 words about a lighthouse keeper who discovers a door in the cliff that was never there before. Take your time and be richly detailed: the storm, the light, the door, what lies beyond, and the keeper's choice. Long and vivid."
wait_up() {
  N=0
  while [ "${N}" -lt 60 ]; do
    if curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; then return 0; fi
    sleep 2
    N=$((N + 1))
  done
  return 1
}
blocked() {
  printf '%s\n' "BLOCKED: $1" > "${OUT}/BLOCKED"
  echo "BLOCKED $1; transcript kept, exiting 0"
  echo "PASS ${RUN_ID} BLOCKED eviction-unproven"
  exit 0
}
{
echo "### 0 key presence by length only"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
echo "caller env carries no OPENCODE_API_KEY"
else
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  blocked "missing-secret plumbing (no OPENCODE_API_KEY in caller env; keyed eviction unreachable)"
fi
wait_up || { echo "BASE ${BASE} not up; cannot start the turn"; exit 1; }
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"
echo "### 2 mint one session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"
echo "### 3 switch to ${KEYED_MODEL} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-switch.json"
KEYED_MODEL="${KEYED_MODEL}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
const want = process.env.KEYED_MODEL.split('/');
if (b.model.provider !== want[0] || b.model.id !== want[1]) throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows ' + process.env.KEYED_MODEL);
" || exit 1
echo "### 4 write the node WS client (incremental frames file, exits on close) plus the frame probe"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT;
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
import { writeFileSync } from "node:fs";
const frames = [];
let close = null;
let settled = false;
function save() {
  writeFileSync(OUTFILE, JSON.stringify({ frames, close }, null, 2) + "\n");
}
function finish(code) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  save();
  process.exit(code);
}
const timer = setTimeout(() => finish(1), 280000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  const frame = { prompt: PROMPT };
  if (FENCE !== undefined) {
    frame.fence = FENCE;
    frame.expected = EXPECTED;
  }
  sock.send(JSON.stringify(frame));
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  save();
  if (frame.done === true || frame.aborted === true) {
    try { sock.close(1000, "client done"); } catch {}
    setTimeout(() => finish(0), 1000);
  } else if (frame.error !== undefined) {
    setTimeout(() => finish(0), 1500);
  }
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  finish(0);
};
sock.onerror = () => {};
EOF
cat > "${OUT}/probe.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const file = process.env.FILE;
const mode = process.env.MODE;
let b;
try { b = JSON.parse(readFileSync(file, "utf8")); } catch { process.exit(1); }
const frames = b.frames || [];
if (mode === "started") {
  process.exit(frames.some((f) => f.entry && f.entry.type === "prompt") ? 0 : 1);
} else if (mode === "done") {
  process.exit(frames.some((f) => f.done === true) ? 0 : 1);
} else if (mode === "blocked") {
  const text = JSON.stringify(frames) + JSON.stringify(b.close);
  process.exit(/error[^}]{0,500}?(429|403|503|quota|rate.?limit|exceeded|insufficient|datapolicy|opt.in|consent|overloaded|unavailable)/i.test(text) ? 0 : 1);
} else if (mode === "over") {
  process.exit(b.close !== null || frames.some((f) => f.done === true || f.aborted === true || f.error !== undefined) ? 0 : 1);
} else if (mode === "ended") {
  process.exit(frames.some((f) => f.done === true || f.aborted === true || f.error !== undefined) ? 0 : 1);
} else { process.exit(2); }
EOF
echo "client plus probe written"
echo "### 4b probe self-test (a crashed probe fails every mode silently; catch it here)"
printf '%s' '{"frames": [{"entry": {"cursor": 1, "type": "prompt", "body": "{}"}}], "close": null}' > "${OUT}/probe-fixture.json"
FILE="${OUT}/probe-fixture.json" MODE="started" node "${OUT}/probe.mjs" || { echo "probe self-test failed: started mode"; exit 1; }
FILE="${OUT}/probe-fixture.json" MODE="bogus" node "${OUT}/probe.mjs" 2>/dev/null; SELFTEST_CODE=$?
if [ "${SELFTEST_CODE}" != "2" ]; then echo "probe self-test failed: bogus mode exit=${SELFTEST_CODE}, want 2 (probe does not load)"; exit 1; fi
echo "probe self-test ok"
echo "### 5 start the slow keyed stream turn in the background"
STREAM_A="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
WS_URL="${STREAM_A}" PROMPT="${LONG_A}" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames-live.json" node "${OUT}/ws-client.mjs" &
CLIENT_A="$!"
echo "client pid=${CLIENT_A}"
echo "### 6 wait until the turn is in flight, then hold for the operator restart"
CODE=0
N=0
while [ "${N}" -lt 90 ]; do
  if FILE="${OUT}/frames-live.json" MODE="started" node "${OUT}/probe.mjs" 2>/dev/null; then CODE=0; break; fi
  if ! kill -0 "${CLIENT_A}" 2>/dev/null; then CODE=1; break; fi
  sleep 2
  N=$((N + 1))
done
if [ "${CODE}" = "2" ]; then blocked "first turn refused (429/quota, 403/opt-in, or 503/overloaded); cause in frames-live.json"; fi
if FILE="${OUT}/frames-live.json" MODE="blocked" node "${OUT}/probe.mjs" 2>/dev/null; then blocked "first turn refused (429/quota, 403/opt-in, or 503/overloaded); cause in frames-live.json"; fi
if [ "${CODE}" != "0" ]; then echo "turn never started; see ${OUT}/frames-live.json"; kill "${CLIENT_A}" 2>/dev/null || true; exit 1; fi
sleep 3
if FILE="${OUT}/frames-live.json" MODE="done" node "${OUT}/probe.mjs" 2>/dev/null; then
  echo "turn finished before any eviction; rerun for a true mid-turn eviction"
  kill "${CLIENT_A}" 2>/dev/null || true
  exit 1
fi
echo "turn in flight; OPERATOR: restart the dev server now (kill -9 plus reboot, same port, same --persist state)"
echo "waiting up to 240s for the eviction drop"
EVICTED=0
M=0
while [ "${M}" -lt 240 ]; do
  if ! kill -0 "${CLIENT_A}" 2>/dev/null; then EVICTED=1; break; fi
  sleep 1
  M=$((M + 1))
done
wait "${CLIENT_A}" 2>/dev/null || true
cp "${OUT}/frames-live.json" "${OUT}/frames-pre.json"
if [ "${EVICTED}" != "1" ]; then
  echo "no eviction observed in 240s; turn left running, killing the client"
  kill "${CLIENT_A}" 2>/dev/null || true
  echo "FAIL ${RUN_ID} no-eviction-observed (rerun with an operator restart mid-turn)"
  exit 1
fi
if FILE="${OUT}/frames-pre.json" MODE="done" node "${OUT}/probe.mjs" 2>/dev/null; then
  echo "turn completed before the drop; no mid-turn eviction captured"
  echo "FAIL ${RUN_ID} completed-before-eviction (rerun with a slower turn or faster restart)"
  exit 1
fi
if FILE="${OUT}/frames-pre.json" MODE="blocked" node "${OUT}/probe.mjs" 2>/dev/null; then blocked "turn refused mid-flight (429/quota, 403/opt-in, or 503/overloaded); cause in frames-pre.json"; fi
if FILE="${OUT}/frames-pre.json" MODE="ended" node "${OUT}/probe.mjs" 2>/dev/null; then
  echo "turn errored or closed before any eviction; no mid-turn drop captured"
  echo "FAIL ${RUN_ID} turn-ended-before-eviction (rerun and restart the server while the turn is in flight)"
  exit 1
fi
echo "eviction observed: socket dropped mid-turn"
echo "### 7 wait for the reboot, then re-read entries plus meta"
wait_up || { echo "server never came back after eviction"; exit 1; }
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries-post.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-post.json"
echo "### 8 LOST inventory: produced frames versus survived SQL rows"
OUT="${OUT}" node -e "
const fs = require('node:fs');
const pre = JSON.parse(fs.readFileSync(process.env.OUT + '/frames-pre.json', 'utf8'));
const replay = JSON.parse(fs.readFileSync(process.env.OUT + '/entries-post.json', 'utf8'));
const byCursor = new Map(replay.entries.map((e) => [e.cursor, e]));
const produced = pre.frames.filter((f) => f.entry);
const byType = {};
for (const f of produced) byType[f.entry.type] = (byType[f.entry.type] || 0) + 1;
const lost = produced.filter((f) => !byCursor.has(f.entry.cursor));
console.log('produced entry-frames=' + produced.length + ' ' + JSON.stringify(byType) + ' survived rows=' + replay.entries.length);
for (const f of lost) console.log('LOST row cursor=' + f.entry.cursor + ' type=' + f.entry.type);
const results = replay.entries.filter((e) => e.type === 'result');
const prompts = replay.entries.filter((e) => e.type === 'prompt');
console.log('survived prompts=' + prompts.length + ' results=' + results.length);
const report = [];
if (lost.length > 0) report.push(lost.length + ' streamed row(s) missing from SQL');
if (results.length === 0) report.push('no result row: the turn never completed');
if (!pre.frames.some((f) => f.done === true)) report.push('no done frame: completion never reached the client');
if (report.length === 0) {
  console.log('healed: every produced row survived and the turn completed');
} else {
  for (const line of report) console.log('LOST ' + line);
  throw new Error('eviction lost the turn: ' + report.join('; '));
}
" || {
  echo "LOST ${RUN_ID} ws=${WS} sid=${SID} (inventory above; current main behavior loses mid-turn evictions)"
  exit 1
}
echo "### 9 redaction grep over the artifacts"
prefix="$(printf '%s' "${OPENCODE_API_KEY}" | cut -c1-16)"
if grep -rF -q -- "${prefix}" "${OUT}"; then
  echo "key material leaked into ${OUT}"
  exit 1
fi
echo "redaction ok: key prefix absent from ${OUT}"
printf '%s\n' "redaction: key prefix absent from ${OUT} (grep exit 1, no match)." > "${OUT}/redaction.txt"
echo "PASS ${RUN_ID} ws=${WS} sid=${SID} (eviction healed)"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
