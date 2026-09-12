#!/bin/sh
# steer-injection.sh — proves steer consumption on the keyed turn loop over
# the real path: a steer sent mid-turn (while the fake upstream holds the
# first model call open) is queued, acked steered:true (the ack only fires
# after markSteerApplied), injected into the same run's context between the
# tool result and the next model call, and quoted verbatim in that run's
# final result ("saw: <steer text>" — the fake upstream answers with the
# last user message it was shown). A steer arriving after run end is
# refused with a no-turn-in-flight error and persists no steer row — the
# recorded boundary: steer rows are scoped to a live runId, so late steers
# are a caller error, not parked state.
# Provider "steerfake" rides a temp models.json (backed up and restored)
# and a fake key passed as a wrangler --var; no real provider is contacted.
# Keyed convention: sources /Users/keyur/Documents/pi-do/worker/.dev.vars;
# without a key the script writes BLOCKED and exits 2.
# Usage: sh verify/steer-injection.sh [BASE]
# Exit 0 on pass, 2 on blocked, 1 otherwise. Writes artifacts/RUN_ID/steer-injection/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/steer-injection"
mkdir -p "${OUT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP_PORT="${UP_PORT:-8899}"
UP_LOG="${OUT}/upstream-requests.log"
: > "${UP_LOG}"
MARKER="steerinject-${RUN_ID}"

if [ -z "${OPENCODE_API_KEY:-}" ]; then
  . /Users/keyur/Documents/pi-do/worker/.dev.vars 2>/dev/null || true
  export OPENCODE_API_KEY
fi
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "blocked: no provider key in env or worker/.dev.vars; the keyed steer path cannot be proven keyless."
  printf '%s\n' "blocked: no provider key (OPENCODE_API_KEY) in caller env or /Users/keyur/Documents/pi-do/worker/.dev.vars." > "${OUT}/BLOCKED"
  exit 2
fi

MODELS_JSON="${ROOT}/worker/models.json"
cp "${MODELS_JSON}" "${OUT}/models.json.backup" || exit 1

NM="${ROOT}/worker/node_modules"
NM_MAIN="/Users/keyur/Documents/pi-do/worker/node_modules"
restore_nm() {
  rm -rf "${NM}"
  ln -s "${NM_MAIN}" "${NM}"
}
if [ -L "${NM}" ]; then
  rm "${NM}"
  mkdir "${NM}"
  (cd "${NM_MAIN}" && find . -maxdepth 1 -mindepth 1 -exec ln -s "${NM_MAIN}/{}" "${NM}/{}" \;) || exit 1
  rm -f "${NM}/pi-cf"
  ln -s "${ROOT}/packages/pi-cf" "${NM}/pi-cf" || exit 1
else
  restore_nm() { :; }
fi

cleanup() {
  mv "${OUT}/models.json.backup" "${MODELS_JSON}" 2>/dev/null
  restore_nm
  lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
  lsof -ti :8787 | xargs kill 2>/dev/null
  [ -n "${UP_PID:-}" ] && kill "${UP_PID}" 2>/dev/null
  [ -n "${DEV_PID:-}" ] && kill "${DEV_PID}" 2>/dev/null
  pkill -f "wrangler dev --port 8787" 2>/dev/null
  return 0
}
trap 'cleanup' EXIT

{
echo "### 1 fake upstream up"
lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
sleep 1
node verify/fixtures/steer-upstream.mjs "${UP_LOG}" "${UP_PORT}" > /dev/null 2>&1 &
UP_PID=$!
sleep 1
if ! kill -0 "${UP_PID}" 2>/dev/null; then
  echo "FAIL: fake upstream did not start on ${UP_PORT}"
  exit 1
fi
echo "upstream pid ${UP_PID} on ${UP_PORT}"

echo "### 2 temp models.json gains provider steerfake"
node -e "
const fs = require('node:fs');
const p = '${MODELS_JSON}';
const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
doc.providers.steerfake = {
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:${UP_PORT}/v1',
  models: [{ id: 'steer-1', name: 'Steer One', api: 'openai-completions', baseUrl: 'http://127.0.0.1:${UP_PORT}/v1', contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
};
fs.writeFileSync(p, JSON.stringify(doc));
console.log('models.json patched');
" || exit 1

echo "### 3 dev server up on 8787"
(cd "${ROOT}/worker" && exec npx wrangler dev --port 8787 --var STEERFAKE_API_KEY:steer-test-key) > "${ROOT}/${OUT}/wrangler-dev.log" 2>&1 &
DEV_PID=$!
READY=0
for i in $(seq 1 90); do
  if curl -s -o /dev/null "${BASE}"; then READY=1; break; fi
  sleep 1
done
if [ "${READY}" != "1" ]; then
  echo "dev server never became ready"
  tail -20 "${ROOT}/${OUT}/wrangler-dev.log"
  exit 1
fi
echo "dev server ready (pid ${DEV_PID})"

echo "### 4 workspace and session on steerfake/steer-1"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
printf '%s\n' "WS=${WS} SID=${SID} MARKER=${MARKER}" > "${OUT}/ids.txt"
${CLI} model --ws "${WS}" --sid "${SID}" --model steerfake/steer-1 --base "${BASE}" --json > /dev/null || exit 1
echo "WS=${WS} SID=${SID}"

echo "### 5 the steered turn: WS client prompts, steers mid-turn, records frames"
STEER="${MARKER}" MARKER="${MARKER}" node -e "
const wsBase = process.argv[1].replace(/^http:/, 'ws:');
const { WebSocket } = globalThis;
const url = wsBase + '/workspaces/' + process.argv[2] + '/sessions/' + process.argv[3] + '/stream';
const sock = new WebSocket(url);
const frames = [];
let steerSent = false;
const marker = process.env.MARKER;
const timer = setTimeout(() => { console.log('FAIL: timed out waiting for done'); process.exit(1); }, 60000);
sock.onmessage = (event) => {
  let f; try { f = JSON.parse(String(event.data)); } catch { return; }
  frames.push(f);
  // Steer right after the turn opens (the prompt entry frame), while the
  // upstream holds the first model call for 4s.
  if (f.entry && f.entry.type === 'prompt' && !steerSent) {
    steerSent = true;
    setTimeout(() => sock.send(JSON.stringify({ steer: true, text: process.env.STEER + ' reply with the marker' })), 800);
  }
  if (f.done === true) {
    clearTimeout(timer);
    require('node:fs').writeFileSync(process.argv[4], frames.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const result = f.result ?? '';
    if (!result.includes('saw: ' + marker)) {
      console.log('FAIL: done result does not quote the steer; result=' + JSON.stringify(result).slice(0, 300));
      process.exit(1);
    }
    const steeredAck = frames.find((x) => x.steered === true);
    if (steeredAck === undefined) {
      console.log('FAIL: no steered:true ack frame (markSteerApplied path unproven)');
      process.exit(1);
    }
    if ((f.steers?.applied ?? -1) < 1 || (f.steers?.pending ?? ['x']).length !== 0) {
      console.log('FAIL: done steers outcome wrong: ' + JSON.stringify(f.steers));
      process.exit(1);
    }
    console.log('frames ok: steered ack, steers outcome ' + JSON.stringify(f.steers) + ', result quotes the steer');
    sock.close();
    process.exit(0);
  }
};
sock.onopen = () => sock.send(JSON.stringify({ prompt: 'SLOW-NOW plan the step' }));
sock.onerror = () => { console.log('FAIL: socket error'); process.exit(1); };
" "${BASE}" "${WS}" "${SID}" "${OUT}/frames.jsonl" || exit 1

echo "### 6 second view: entries carry the steer and the quoting result, in order"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const entries = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8')).entries || [];
const marker = process.env.MARKER;
const steers = entries.filter((e) => e.type === 'steer' && String(e.body).includes(marker));
const results = entries.filter((e) => e.type === 'result' && String(e.body).includes('saw: ' + marker));
if (steers.length !== 1) throw new Error('expected exactly 1 persisted steer entry with the marker, got ' + steers.length);
if (results.length !== 1) throw new Error('expected exactly 1 result quoting the steer, got ' + results.length);
if (!(steers[0].cursor < results[0].cursor)) throw new Error('steer entry must precede the quoting result');
console.log('entries ok: steer cursor ' + steers[0].cursor + ' < result cursor ' + results[0].cursor + ', same runId ' + JSON.parse(steers[0].body).runId);
" || exit 1

echo "### 7 late steer after run end: refused, no steer row persisted"
LATE="late-${RUN_ID}" MARKER="${MARKER}" OUT="${OUT}" node -e "
const wsBase = process.argv[1].replace(/^http:/, 'ws:');
const { WebSocket } = globalThis;
const url = wsBase + '/workspaces/' + process.argv[2] + '/sessions/' + process.argv[3] + '/stream';
const sock = new WebSocket(url);
const timer = setTimeout(() => { console.log('FAIL: no error frame for the late steer'); process.exit(1); }, 15000);
sock.onmessage = (event) => {
  let f; try { f = JSON.parse(String(event.data)); } catch { return; }
  if (f.error) {
    clearTimeout(timer);
    if (!/no turn in flight/i.test(f.error) || !f.hint) {
      console.log('FAIL: late steer error shape wrong: ' + JSON.stringify(f));
      process.exit(1);
    }
    console.log('late steer ok: refused with hint — ' + JSON.stringify(f.error));
    sock.close();
    process.exit(0);
  }
};
sock.onopen = () => sock.send(JSON.stringify({ steer: true, text: process.env.LATE }));
sock.onerror = () => { console.log('FAIL: socket error'); process.exit(1); };
" "${BASE}" "${WS}" "${SID}" || exit 1
ENTRIES2_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES2_JSON}" > "${OUT}/entries-after-late.json"
LATE="${RUN_ID}" node -e "
const fs = require('node:fs');
const entries = JSON.parse(fs.readFileSync('${OUT}/entries-after-late.json', 'utf8')).entries || [];
const late = entries.filter((e) => e.type === 'steer' && String(e.body).includes('late-' + process.env.LATE));
if (late.length !== 0) throw new Error('late steer persisted a row: ' + JSON.stringify(late));
console.log('late steer ok: no steer entry persisted');
" || exit 1

echo "### 8 upstream log: 2 model calls this run (tool call, then post-steer call)"
grep -c . "${UP_LOG}"
grep . "${UP_LOG}" | tail -2

echo "### 9 redaction grep over the artifacts"
if grep -rF -q -- "steer-test-key" "${OUT}"; then
  echo "fake key material leaked into ${OUT}"
  exit 1
fi
echo "redaction ok: fake key absent from ${OUT}"

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
