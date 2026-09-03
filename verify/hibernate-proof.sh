#!/bin/sh
# hibernate-proof.sh — proves WS hibernation resume: stream one fenced turn,
# snapshot entries plus meta, survive a documented wrangler-level eviction
# (full dev-server restart between prompt and resume), then assert the stream
# resumes gapless from the entries cursor with fence and revision intact while
# a second fenced turn completes and rotates.
# Usage: sh verify/hibernate-proof.sh [BASE]
# Eviction: when the script asks, restart `wrangler dev` in another terminal.
# It polls for the disconnect and the return (90s each) and continues alone.
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/hibernate-proof/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/hibernate-proof"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the stub reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"

echo "### 4 write the node WS client (global WebSocket, zero deps)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
import { writeFileSync } from "node:fs";

const frames = [];
let close = null;
let settled = false;
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2));
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 30000);
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
  if (frame.done === true) {
    try {
      sock.close(1000, "client done");
    } catch {
      // Already closing; the fallback below still records the frames.
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

echo "### 5 stream turn one (pre-eviction prompt)"
STREAM1="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
WS_URL="${STREAM1}" PROMPT="read seed.txt" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames1.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames1.json"
F1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames1.json','utf8')).frames.find((f)=>f.done===true).fence")"
R1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames1.json','utf8')).frames.find((f)=>f.done===true).revision")"
echo "F1=${F1} R1=${R1}"

echo "### 6 snapshot entries plus meta (second view, pre-eviction)"
ENTRIES1_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES1_JSON}" > "${OUT}/entries1.json"
META1_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META1_JSON}" > "${OUT}/meta1.json"
HEAD1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/entries1.json','utf8')).head")"
echo "HEAD1=${HEAD1}"

echo "### 7 EVICT NOW: restart wrangler dev in another terminal (full workerd restart)"
i=0
while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "${i}" -ge 45 ]; then echo "eviction never observed; restart wrangler dev and rerun"; exit 1; fi
  sleep 2
done
echo "disconnect observed; waiting for the server to return"
i=0
while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "${i}" -ge 45 ]; then echo "server never returned after eviction"; exit 1; fi
  sleep 2
done
echo "server back; the DO wakes cold on next request"

echo "### 8 second view after eviction: fence, revision, gapless cursors intact"
ENTRIES2_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES2_JSON}" > "${OUT}/entries2.json"
META2_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META2_JSON}" > "${OUT}/meta2.json"
F1="${F1}" R1="${R1}" HEAD1="${HEAD1}" node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('${OUT}/meta2.json', 'utf8'));
const entries = replay.entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
if (replay.head !== Number(process.env.HEAD1)) throw new Error('head moved across eviction: ' + replay.head);
if (meta.openRun !== null) throw new Error('expected no open run after a clean turn, got ' + JSON.stringify(meta.openRun));
console.log('resume ok: ' + entries.length + ' entries gapless, head ' + replay.head + ', no open run');
" || exit 1

echo "### 9 stream turn two on the woken DO with the pre-eviction fence"
STREAM2="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F1}&expected=${R1}"
WS_URL="${STREAM2}" PROMPT="read seed.txt again" FENCE="${F1}" EXPECTED="${R1}" OUTFILE="${OUT}/frames2.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames2.json"
F1="${F1}" R1="${R1}" SEED_BODY="${SEED_BODY}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames2.json', 'utf8'));
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error('missing {done} on the resumed stream');
if (done.fence === process.env.F1) throw new Error('resumed turn must rotate the fence');
if (done.revision !== Number(process.env.R1) + 1) throw new Error('done revision must be ' + (Number(process.env.R1) + 1) + ', got ' + JSON.stringify(done.revision));
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('resumed result missing seeded read');
console.log('turn two ok: fence rotated, revision ' + process.env.R1 + '->' + done.revision);
" || exit 1

echo "### 10 every resumed entry frame byte-matches storage in cursor order"
ENTRIES3_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES3_JSON}" > "${OUT}/entries3.json"
HEAD1="${HEAD1}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames2.json', 'utf8'));
const replay = JSON.parse(fs.readFileSync('${OUT}/entries3.json', 'utf8'));
const byCursor = new Map(replay.entries.map((e) => [e.cursor, e]));
const entryFrames = b.frames.filter((f) => f.entry);
if (entryFrames.length === 0) throw new Error('no entry frames streamed');
for (const f of entryFrames) {
  const s = byCursor.get(f.entry.cursor);
  if (!s) throw new Error('streamed cursor ' + f.entry.cursor + ' missing from storage');
  if (s.type !== f.entry.type || s.body !== f.entry.body) throw new Error('byte mismatch at cursor ' + f.entry.cursor);
}
const cursors = replay.entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
if (cursors[0] !== 1 || replay.head <= Number(process.env.HEAD1)) throw new Error('resume must continue the same cursor sequence');
console.log('byte-compare ok: ' + entryFrames.length + ' entry frames match storage re-reads');
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
