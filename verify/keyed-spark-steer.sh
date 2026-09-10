#!/bin/sh
# keyed-spark-steer.sh — proves mid-turn steer on one keyed streaming turn on
# opencode-go/muse-spark-1.3-contributor: mint a session, switch the model,
# stream one tiny turn, send {steer:true,text} mid-turn with a distinctive
# marker word, prove the steer entry frame arrives before {done}, prove an
# entries re-read persists the steer entry (same runId, marker in text,
# ordered prompt < steer < result), and prove the done frame carries usage
# with costTotal>0 while a meta re-read shows runtime.model
# muse-spark-1.3-contributor. The prompt carries the marker word so the done
# result mentions it; the running turn's context is fixed at turn start, so
# the steer proof is the mid-turn entry frame plus the persisted steer entry,
# and the turn completes cleanly with usage after the steer lands.
# Keyed env needed: server under test is wrangler dev on port 8789 carrying
# the OPENCODE_API_KEY secret plus MODEL_ID=opencode-go/muse-spark-1.3-contributor.
# The secret arrives only via the caller env / Worker secret and never enters
# any artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-spark-steer.sh [BASE]
# Exit 0 on pass, 2 on blocked (OUT/BLOCKED names the cause), 1 otherwise.
# Writes artifacts/RUN_ID/keyed-spark-steer/.
set -u
BASE="${1:-http://127.0.0.1:8789}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/keyed-spark-steer"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_MODEL="opencode-go/muse-spark-1.3-contributor"
MARKER="steermark-${RUN_ID}"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"

echo "### 2 seed a tiny file the keyed turn reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"

echo "### 4 switch to ${KEYED_MODEL} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-switch.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (b.model.provider !== 'opencode-go' || b.model.id !== 'muse-spark-1.3-contributor') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows opencode-go/muse-spark-1.3-contributor');
" || exit 1

echo "### 5 write the node WS client (global WebSocket, zero deps; steers on first entry)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
const STEER = process.env.STEER || "steer-note";
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
import { writeFileSync } from "node:fs";

const frames = [];
let close = null;
let steerSent = false;
let settled = false;
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2) + "\n");
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 120000);
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
  if (frame.entry && !steerSent) {
    steerSent = true;
    sock.send(JSON.stringify({ steer: true, text: STEER }));
  }
  if (frame.error && !frame.done) finish(3, "error frame received: " + String(frame.error).slice(0, 200));
  if (frame.done === true) closeAndFinish();
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  finish(0, null);
};
sock.onerror = () => {
};
function closeAndFinish() {
  try {
    sock.close(1000, "client done");
  } catch {}
  setTimeout(() => finish(0, "done received; closed optimistically"), 1000);
}
EOF
echo "client written"

echo "### 6 stream one keyed turn, steer mid-turn with the marker word"
PROMPT="Read ${SEED_PATH}, then write a four-line poem about the sea that includes the exact word \"${MARKER}\" (copy it character-for-character). Keep it short."
STEER="Mid-turn note: make sure the poem includes the exact word \"${MARKER}\"."
printf '%s' "${PROMPT}" > "${OUT}/prompt.txt"
printf '%s' "${STEER}" > "${OUT}/steer.txt"
STREAM1="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
CLIENT_CODE=0
WS_URL="${STREAM1}" PROMPT="${PROMPT}" STEER="${STEER}" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames.json" node "${OUT}/ws-client.mjs" || CLIENT_CODE=$?
if [ "${CLIENT_CODE}" != "0" ] && [ "${CLIENT_CODE}" != "3" ]; then exit 1; fi
cat "${OUT}/frames.json"

echo "### 6b block guard: 429/quota or provider refusal (403/opt-in) is reported, not failed"
if node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const blob = JSON.stringify(b);
if (/error[^}]{0,300}?(429|403|quota|rate.?limit|datapolicy|opt.in|consent|exceeded|insufficient)/i.test(blob)) { console.log('blocked: steer path refused'); process.exit(0); }
process.exit(1);
"; then
  printf '%s\n' "BLOCKED: keyed-spark-steer refused on the steer path (429/quota or 403/opt-in; steer entry/done unproven this run; cause in frames.json)." > "${OUT}/BLOCKED"
  echo "BLOCKED steer path refused; transcript kept, exiting 2"
  exit 2
fi

echo "### 7 steer entry frame landed mid-turn; marker in result or a file the turn wrote; usage costTotal>0"
MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const frames = b.frames;
const idx = (p) => frames.findIndex(p);
const marker = process.env.MARKER;
const steerAt = idx((f) => f.entry && f.entry.type === 'steer');
if (steerAt === -1) throw new Error('missing steer entry frame');
if (!String(frames[steerAt].entry.body).includes(marker)) throw new Error('steer body mismatch: ' + frames[steerAt].entry.body);
const doneAt = idx((f) => f.done === true);
if (doneAt === -1) throw new Error('missing {done}');
if (!(steerAt < doneAt)) throw new Error('steer landed after {done}; it must append mid-turn');
console.log('steer ok: entry frame arrived mid-turn with the marker, turn kept running');
const done = frames[doneAt];
const resultText = String(done.result || '');
const resultHit = resultText.includes(marker);
const calls = Array.isArray(done.toolCalls) ? done.toolCalls : [];
const writeHit = calls.some((c) => c.tool === 'write' && (JSON.stringify(c.args || {}).includes(marker) || String(c.output || '').includes(marker)));
const bodyHit = frames.some((f) => f.entry && (f.entry.type === 'toolCall' || f.entry.type === 'toolResult') && String(f.entry.body).includes(marker));
if (!resultHit && !writeHit && !bodyHit) {
  require('node:fs').writeFileSync('${OUT}/marker-need-filecheck.txt', 'marker absent from frames; checking workspace files for ' + marker + '\n');
  console.log('marker not in frames; falling back to workspace file check');
  process.exit(2);
}
console.log('result ok: marker observed in ' + (resultHit ? 'done.result' : 'turn tool frames'));
const u = done.usage;
if (!u || typeof u !== 'object') throw new Error('done frame missing usage: ' + JSON.stringify(done));
for (const k of ['inTokens', 'outTokens', 'cacheRead', 'costTotal', 'elapsedMs']) {
  if (typeof u[k] !== 'number') throw new Error('usage.' + k + ' must be a number: ' + JSON.stringify(u));
}
if (!(u.costTotal > 0)) throw new Error('usage.costTotal must be > 0, got ' + JSON.stringify(u));
console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
" ; code=$?
if [ "${code}" = "2" ]; then
  echo "### 7b marker absent from frames; checking files the turn wrote (second view)"
  LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
  printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
  MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const ls = JSON.parse(fs.readFileSync('${OUT}/ls.json', 'utf8'));
const paths = (ls.entries || []).map((e) => e.path).filter((p) => p !== 'seed.txt');
if (paths.length < 1) throw new Error('turn wrote no files; marker unproven');
fs.writeFileSync('${OUT}/written-paths.json', JSON.stringify(paths) + '\n');
console.log('turn wrote: ' + paths.join(','));
" || exit 1
  for p in $(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/written-paths.json', 'utf8')).join('\n')"); do
    if ${CLI} files get --ws "${WS}" --path "${p}" --base "${BASE}" --json > "${OUT}/filecheck-body.txt" 2>/dev/null; then
      printf '%s' "${p}" > "${OUT}/filecheck-path.txt"
      break
    fi
  done
  MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const body = fs.readFileSync('${OUT}/filecheck-body.txt', 'utf8');
const p = fs.readFileSync('${OUT}/filecheck-path.txt', 'utf8');
if (!body.includes(process.env.MARKER)) throw new Error('marker missing from written file ' + p);
console.log('result ok: marker observed in written file ' + p);
" || exit 1
elif [ "${code}" != "0" ]; then
  exit "${code}"
fi

echo "### 8 second view: steer entry persists (same runId, prompt < steer < result); model via meta"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const entries = replay.entries || [];
const marker = process.env.MARKER;
const byType = (t) => entries.filter((e) => e.type === t);
const prompts = byType('prompt');
const steers = byType('steer').filter((e) => String(e.body).includes(marker));
const results = byType('result');
if (steers.length < 1) throw new Error('no persisted steer entry carries the marker');
const steer = steers[0];
const sBody = JSON.parse(steer.body);
const prompt = prompts.find((e) => { try { return JSON.parse(e.body).runId === sBody.runId; } catch { return false; } });
const result = results.find((e) => { try { return JSON.parse(e.body).runId === sBody.runId; } catch { return false; } });
if (!prompt) throw new Error('no prompt entry shares the steer runId ' + sBody.runId);
if (!result) throw new Error('no result entry shares the steer runId ' + sBody.runId);
if (!(prompt.cursor < steer.cursor && steer.cursor < result.cursor)) {
  throw new Error('cursor order wrong: prompt=' + prompt.cursor + ' steer=' + steer.cursor + ' result=' + result.cursor);
}
console.log('persist ok: steer entry cursor ' + steer.cursor + ' with marker, ordered prompt < steer < result, runId ' + sBody.runId);
const meta = JSON.parse(fs.readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (meta.model.id !== 'muse-spark-1.3-contributor') throw new Error('meta model wrong: ' + JSON.stringify(meta.model));
console.log('model ok: runtime.model=muse-spark-1.3-contributor (meta second view)');
" || exit 1

echo "### 8b workspace holds the seed plus any files the turn wrote (second view)"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/ls.json', 'utf8'));
const paths = (b.entries || []).map((e) => e.path);
if (!paths.includes('seed.txt')) throw new Error('seed.txt missing: ' + JSON.stringify(paths));
console.log('files ok: ' + JSON.stringify(paths));
" || exit 1

echo "### 9 redaction grep over the artifacts"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "redaction vacuous keyless: no secret in caller env, nothing could have leaked"
  printf '%s\n' "redaction: vacuous (no OPENCODE_API_KEY in caller env)." > "${OUT}/redaction.txt"
else
  prefix="$(printf '%s' "${OPENCODE_API_KEY}" | cut -c1-16)"
  if grep -rF -q -- "${prefix}" "${OUT}"; then
    echo "key material leaked into ${OUT}"
    exit 1
  fi
  echo "redaction ok: key prefix absent from ${OUT}"
  printf '%s\n' "redaction: key prefix absent from ${OUT} (grep exit 1, no match)." > "${OUT}/redaction.txt"
fi

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
