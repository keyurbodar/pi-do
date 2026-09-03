#!/bin/sh
# stream-protocol.sh — proves live turns over WebSocket: mint a session,
# stream one turn and byte-compare every entry frame against a storage
# re-read, prove abort-then-next-prompt continues with the prior run marked
# interrupted, prove busy while a turn runs, and prove stale-fence and
# unknown-session connects get a close frame with the hint (never a drop).
# Usage: sh verify/stream-protocol.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/stream-protocol/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/stream-protocol"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
MARKER="harness-bash-ok"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the stub reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1

echo "### 3 mint a session (fence F0, revision 0)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"

echo "### 4 write the node WS client (global WebSocket, zero deps)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const MODE = process.env.MODE || "turn";
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
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
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2));
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 30000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  if (MODE === "turn") {
    const frame = { prompt: PROMPT };
    if (FENCE !== undefined) {
      frame.fence = FENCE;
      frame.expected = EXPECTED;
    }
    sock.send(JSON.stringify(frame));
  } else if (MODE === "live") {
    sock.send(JSON.stringify({ prompt: "read seed.txt", fence: FENCE, expected: EXPECTED }));
    sock.send(JSON.stringify({ prompt: "second while busy", fence: FENCE, expected: EXPECTED }));
    setTimeout(() => {
      try {
        sock.send(JSON.stringify({ abort: true }));
      } catch {
        // Socket already closed; the close handler records the outcome.
      }
    }, 150);
  }
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if (MODE === "live") {
    if (frame.entry && !steerSent) {
      steerSent = true;
      sock.send(JSON.stringify({ steer: true, text: "steer-note-live" }));
    }
    if (frame.aborted === true) {
      sock.send(JSON.stringify({ prompt: "read seed.txt again", fence: FENCE, expected: EXPECTED }));
    }
    if (frame.done === true) closeAndFinish();
  } else if (frame.done === true) {
    closeAndFinish();
  }
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  finish(0, null);
};
sock.onerror = () => {
  // A close event follows; it records the outcome.
};
function closeAndFinish() {
  try {
    sock.close(1000, "client done");
  } catch {
    // Already closing; the fallback below still records the frames.
  }
  setTimeout(() => finish(0, "done received; closed optimistically"), 1000);
};
EOF
echo "client written"

echo "### 5 stream one clean turn"
STREAM1="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
WS_URL="${STREAM1}" MODE=turn PROMPT="read seed.txt" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames1.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames1.json"
F1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames1.json','utf8')).frames.find((f)=>f.done===true).fence")"
R1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames1.json','utf8')).frames.find((f)=>f.done===true).revision")"
echo "F1=${F1} R1=${R1}"
SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" F0="${F0}" F1="${F1}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames1.json', 'utf8'));
const types = b.frames.filter((f) => f.entry).map((f) => f.entry.type);
const want = ['prompt', 'toolCall', 'toolResult', 'toolCall', 'toolResult', 'result'];
if (JSON.stringify(types) !== JSON.stringify(want)) throw new Error('entry sequence ' + JSON.stringify(types));
console.log('sequence ok: prompt + read/bash tool events + result');
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error('missing {done}');
if (done.fence === process.env.F0 || typeof done.fence !== 'string') throw new Error('done must rotate the fence');
if (done.revision !== 1) throw new Error('done revision must be 1, got ' + JSON.stringify(done.revision));
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('done result missing seeded read');
if (!String(done.result || '').includes(process.env.MARKER)) throw new Error('done result missing bash marker');
console.log('done ok: fence rotated, revision 0->1, result carries read + marker');
" || exit 1

echo "### 6 every entry frame matches a storage re-read (byte-compare bodies in cursor order)"
ENTRIES1_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES1_JSON}" > "${OUT}/entries1.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames1.json', 'utf8'));
const replay = JSON.parse(fs.readFileSync('${OUT}/entries1.json', 'utf8'));
const byCursor = new Map(replay.entries.map((e) => [e.cursor, e]));
const entryFrames = b.frames.filter((f) => f.entry);
if (entryFrames.length === 0) throw new Error('no entry frames streamed');
for (const f of entryFrames) {
  const s = byCursor.get(f.entry.cursor);
  if (!s) throw new Error('streamed cursor ' + f.entry.cursor + ' missing from storage');
  if (s.type !== f.entry.type || s.body !== f.entry.body) {
    throw new Error('byte mismatch at cursor ' + f.entry.cursor);
  }
}
console.log('byte-compare ok: ' + entryFrames.length + ' entry frames match storage re-reads');
" || exit 1

echo "### 7 plain GET without upgrade fails closed 400"
node -e "
fetch('${BASE}/workspaces/${WS}/sessions/${SID}/stream').then(async (res) => {
  if (res.status !== 400) throw new Error('expected HTTP 400, got ' + res.status);
  const b = await res.json();
  if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
  console.log('400 ok: ' + b.error);
}).catch((e) => { console.error(e.message); process.exit(1); });
" || exit 1

echo "### 8 busy + steer + abort, then the next prompt continues cleanly"
STREAM2="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F1}&expected=${R1}"
WS_URL="${STREAM2}" MODE=live FENCE="${F1}" EXPECTED="${R1}" OUTFILE="${OUT}/frames2.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames2.json"
F2="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames2.json','utf8')).frames.find((f)=>f.done===true).fence")"
R2="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames2.json','utf8')).frames.find((f)=>f.done===true).revision")"
echo "F2=${F2} R2=${R2}"
SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" F1="${F1}" F2="${F2}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames2.json', 'utf8'));
const frames = b.frames;
const idx = (p) => frames.findIndex(p);
const busy = frames.find((f) => f.busy === true);
if (!busy || typeof busy.hint !== 'string') throw new Error('missing {busy} with a hint');
console.log('busy ok: ' + busy.hint);
const abortedAt = idx((f) => f.aborted === true);
if (abortedAt === -1) throw new Error('missing {aborted}');
const aborted = frames[abortedAt];
console.log('aborted ok: run ' + aborted.runId);
const steerAt = idx((f) => f.entry && f.entry.type === 'steer');
if (steerAt === -1) throw new Error('missing steer entry frame');
if (steerAt > abortedAt) throw new Error('steer landed after the abort; it must append mid-turn');
if (!frames[steerAt].entry.body.includes('steer-note-live')) throw new Error('steer body mismatch');
console.log('steer ok: entry frame arrived mid-turn, turn kept running');
const doneAt = idx((f) => f.done === true);
if (doneAt === -1 || doneAt < abortedAt) throw new Error('missing {done} after the abort');
const done = frames[doneAt];
if (done.fence === process.env.F1) throw new Error('next-prompt done must rotate the fence');
if (done.revision !== 2) throw new Error('done revision must be 2, got ' + JSON.stringify(done.revision));
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('next prompt result missing seeded read');
if (!String(done.result || '').includes(process.env.MARKER)) throw new Error('next prompt result missing bash marker');
console.log('next prompt ok: continued cleanly, fence rotated, revision 1->2');
" || exit 1

echo "### 9 second view: prior run marked interrupted, cursors gapless, no open run"
ENTRIES2_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES2_JSON}" > "${OUT}/entries2.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta.json"
node -e "
const fs = require('node:fs');
const frames = JSON.parse(fs.readFileSync('${OUT}/frames2.json', 'utf8')).frames;
const aborted = frames.find((f) => f.aborted === true);
const replay = JSON.parse(fs.readFileSync('${OUT}/entries2.json', 'utf8'));
const entries = replay.entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
console.log('cursor order ok: ' + cursors.length + ' entries, no gaps');
const interrupted = entries.filter((e) => e.type === 'interrupted');
const hit = interrupted.find((e) => { try { return JSON.parse(e.body).runId === aborted.runId; } catch { return false; } });
if (!hit) throw new Error('no interrupted entry for the aborted run ' + aborted.runId);
console.log('interrupted ok: prior run ' + aborted.runId + ' marked interrupted');
const again = entries.find((e) => e.type === 'prompt' && e.body.includes('read seed.txt again'));
if (!again || again.cursor < hit.cursor) throw new Error('next prompt missing after the abort');
console.log('continue ok: next prompt persisted at cursor ' + again.cursor);
const meta = JSON.parse(fs.readFileSync('${OUT}/meta.json', 'utf8'));
if (meta.openRun !== null) throw new Error('expected no open run, got ' + JSON.stringify(meta.openRun));
console.log('ledger ok: no open run left');
" || exit 1

echo "### 10 stale-fence connect gets a close frame with the hint"
STALE="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=dead-${RUN_ID}&expected=999"
WS_URL="${STALE}" MODE=quiet OUTFILE="${OUT}/frames-stale.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames-stale.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-stale.json', 'utf8'));
if (!b.close) throw new Error('stale fence must close the socket, never leave it hanging');
const hint = b.frames.map((f) => f.hint || '').join(' ') + ' ' + (b.close.reason || '');
if (!/Fenced|fence/i.test(hint)) throw new Error('stale close must carry the fence hint, got: ' + JSON.stringify(b));
console.log('stale close ok: code=' + b.close.code + ' hint present');
" || exit 1

echo "### 11 unknown-session connect gets a close frame with the hint"
UNKNOWN="${WS_BASE}/workspaces/${WS}/sessions/nope-${RUN_ID}/stream"
WS_URL="${UNKNOWN}" MODE=quiet OUTFILE="${OUT}/frames-unknown.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames-unknown.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-unknown.json', 'utf8'));
if (!b.close) throw new Error('unknown session must close the socket, never bare-drop it');
const hint = b.frames.map((f) => (f.error || '') + ' ' + (f.hint || '')).join(' ') + ' ' + (b.close.reason || '');
if (!/unknown session/i.test(hint)) throw new Error('unknown close must carry the hint, got: ' + JSON.stringify(b));
console.log('unknown close ok: code=' + b.close.code + ' hint present');
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
