#!/bin/sh
# queue-order.sh — proves one prompt runs per session at a time across POST
# /run and the WS stream path: two concurrent POST turns serialize in arrival
# order with gapless entries and correct results, a WS turn plus a concurrent
# POST share the same chain with no {busy} reject, and a prompt sent after an
# abort still executes once the abort releases the chain.
# Usage: sh verify/queue-order.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/queue-order/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/queue-order"
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

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 two concurrent POST /run turns serialize in arrival order"
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt queue-first" --base "${BASE}" --json > "${OUT}/runA.json" 2> "${OUT}/runA.stderr" &
PA=$!
sleep 1
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt queue-second" --base "${BASE}" --json > "${OUT}/runB.json" 2> "${OUT}/runB.stderr" &
PB=$!
wait "${PA}"; CA=$?
wait "${PB}"; CB=$?
echo "runA exit=${CA} runB exit=${CB}"
[ "${CA}" = "0" ] || { echo "first queued turn failed"; cat "${OUT}/runA.json" "${OUT}/runA.stderr"; exit 1; }
[ "${CB}" = "0" ] || { echo "second queued turn must wait its turn, not fail"; cat "${OUT}/runB.json" "${OUT}/runB.stderr"; exit 1; }
cat "${OUT}/runA.json" "${OUT}/runB.json"
ENTRIES_AB_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_AB_JSON}" > "${OUT}/entriesAB.json"
SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const a = JSON.parse(fs.readFileSync('${OUT}/runA.json', 'utf8'));
const b = JSON.parse(fs.readFileSync('${OUT}/runB.json', 'utf8'));
for (const [name, r] of [['first', a], ['second', b]]) {
  if (typeof r.result !== 'string') throw new Error(name + ' run must return a result string');
  if (!r.result.includes(process.env.SEED_BODY)) throw new Error(name + ' result missing seeded read');
  if (!r.result.includes(process.env.MARKER)) throw new Error(name + ' result missing bash marker');
  if (!Array.isArray(r.toolCalls) || r.toolCalls.length === 0) throw new Error(name + ' run must list toolCalls');
}
console.log('results ok: both queued turns returned the seeded read plus the bash marker');
const entries = JSON.parse(fs.readFileSync('${OUT}/entriesAB.json', 'utf8')).entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
console.log('gapless ok: ' + entries.length + ' entries in cursor order');
const byRun = new Map();
for (const e of entries) {
  let b;
  try { b = JSON.parse(e.body); } catch { continue; }
  if (!b || typeof b.runId !== 'string') continue;
  if (!byRun.has(b.runId)) byRun.set(b.runId, []);
  byRun.get(b.runId).push(e.cursor);
}
const runOf = (needle) => {
  const hit = entries.find((e) => e.type === 'prompt' && String(e.body).includes(needle));
  if (!hit) throw new Error('prompt entry missing for ' + needle);
  return JSON.parse(hit.body).runId;
};
const firstRun = runOf('queue-first');
const secondRun = runOf('queue-second');
if (firstRun === secondRun) throw new Error('queued turns must be distinct runs');
const ca = byRun.get(firstRun);
const cb = byRun.get(secondRun);
if (Math.max(...ca) >= Math.min(...cb)) {
  throw new Error('turns interleaved: first cursors ' + JSON.stringify(ca) + ' second ' + JSON.stringify(cb));
}
console.log('ordered ok: first run cursors ' + JSON.stringify(ca) + ' all precede second ' + JSON.stringify(cb));
" || exit 1

echo "### 5 write the node WS client (global WebSocket, zero deps)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const MODE = process.env.MODE || "queue";
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
import { writeFileSync } from "node:fs";
const frames = [];
let close = null;
let settled = false;
let abortSent = false;
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2));
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 60000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  sock.send(JSON.stringify({ prompt: PROMPT }));
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if (MODE === "abort") {
    if (frame.entry && !abortSent) {
      abortSent = true;
      setTimeout(() => {
        try {
          sock.send(JSON.stringify({ abort: true }));
        } catch {
          // Socket already closed; the close handler records the outcome.
        }
      }, 150);
    }
    if (frame.aborted === true) {
      sock.send(JSON.stringify({ prompt: "read seed.txt again" }));
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

echo "### 6 WS turn plus a concurrent POST share one chain (no busy reject)"
STREAM_W="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream"
WS_URL="${STREAM_W}" MODE=queue PROMPT="read seed.txt queue-ws" OUTFILE="${OUT}/framesW.json" node "${OUT}/ws-client.mjs" &
PW=$!
sleep 1
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt queue-post" --base "${BASE}" --json > "${OUT}/runP.json" 2> "${OUT}/runP.stderr" &
PP=$!
wait "${PP}"; CP=$?
wait "${PW}"; CW=$?
echo "ws exit=${CW} post exit=${CP}"
[ "${CP}" = "0" ] || { echo "POST queued behind the WS turn failed"; cat "${OUT}/runP.json" "${OUT}/runP.stderr"; exit 1; }
[ "${CW}" = "0" ] || { echo "WS turn failed"; cat "${OUT}/framesW.json"; exit 1; }
cat "${OUT}/framesW.json" "${OUT}/runP.json"
ENTRIES_WP_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_WP_JSON}" > "${OUT}/entriesWP.json"
SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const w = JSON.parse(fs.readFileSync('${OUT}/framesW.json', 'utf8'));
const frames = w.frames;
if (frames.some((f) => f.busy === true)) throw new Error('queued paths must serialize, never answer {busy:true}');
const done = frames.find((f) => f.done === true);
if (!done) throw new Error('WS turn missing {done}');
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('WS result missing seeded read');
if (!String(done.result || '').includes(process.env.MARKER)) throw new Error('WS result missing bash marker');
const p = JSON.parse(fs.readFileSync('${OUT}/runP.json', 'utf8'));
if (!String(p.result || '').includes(process.env.SEED_BODY)) throw new Error('POST result missing seeded read');
if (!String(p.result || '').includes(process.env.MARKER)) throw new Error('POST result missing bash marker');
console.log('results ok: WS turn and queued POST both returned the seeded read plus the bash marker');
const entries = JSON.parse(fs.readFileSync('${OUT}/entriesWP.json', 'utf8')).entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
const byRun = new Map();
for (const e of entries) {
  let b;
  try { b = JSON.parse(e.body); } catch { continue; }
  if (!b || typeof b.runId !== 'string') continue;
  if (!byRun.has(b.runId)) byRun.set(b.runId, []);
  byRun.get(b.runId).push(e.cursor);
}
const runOf = (needle) => {
  const hit = entries.find((e) => e.type === 'prompt' && String(e.body).includes(needle));
  if (!hit) throw new Error('prompt entry missing for ' + needle);
  return JSON.parse(hit.body).runId;
};
const wRun = runOf('queue-ws');
const pRun = runOf('queue-post');
if (wRun === pRun) throw new Error('WS turn and POST turn must be distinct runs');
const wc = byRun.get(wRun);
const pc = byRun.get(pRun);
if (Math.max(...wc) >= Math.min(...pc)) {
  throw new Error('paths interleaved: ws cursors ' + JSON.stringify(wc) + ' post ' + JSON.stringify(pc));
}
console.log('ordered ok: ws run ' + wRun + ' cursors precede post run ' + pRun + '; one chain, no interleave');
" || exit 1

echo "### 7 abort releases the chain, then the next prompt still executes"
WS_URL="${STREAM_W}" MODE=abort PROMPT="read seed.txt queue-abort" OUTFILE="${OUT}/framesAbort.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/framesAbort.json"
SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const frames = JSON.parse(fs.readFileSync('${OUT}/framesAbort.json', 'utf8')).frames;
const idx = (p) => frames.findIndex(p);
const abortedAt = idx((f) => f.aborted === true);
if (abortedAt === -1) throw new Error('missing {aborted} for the cancelled turn');
const aborted = frames[abortedAt];
console.log('aborted ok: run ' + aborted.runId);
const doneAt = idx((f) => f.done === true);
if (doneAt === -1 || doneAt < abortedAt) throw new Error('missing {done} after the abort');
const done = frames[doneAt];
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('post-abort result missing seeded read');
if (!String(done.result || '').includes(process.env.MARKER)) throw new Error('post-abort result missing bash marker');
console.log('post-abort ok: next prompt executed cleanly with the seeded read plus the bash marker');
" || exit 1

echo "### 8 second view: aborted run marked interrupted, next prompt persisted, no open run"
ENTRIES_C_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_C_JSON}" > "${OUT}/entriesC.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta.json"
node -e "
const fs = require('node:fs');
const frames = JSON.parse(fs.readFileSync('${OUT}/framesAbort.json', 'utf8')).frames;
const aborted = frames.find((f) => f.aborted === true);
const entries = JSON.parse(fs.readFileSync('${OUT}/entriesC.json', 'utf8')).entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
console.log('cursor order ok: ' + cursors.length + ' entries, no gaps');
const hit = entries.find((e) => {
  if (e.type !== 'interrupted') return false;
  try { return JSON.parse(e.body).runId === aborted.runId; } catch { return false; }
});
if (!hit) throw new Error('no interrupted entry for the aborted run ' + aborted.runId);
console.log('interrupted ok: prior run ' + aborted.runId + ' marked interrupted');
const again = entries.find((e) => e.type === 'prompt' && e.body.includes('read seed.txt again'));
if (!again || again.cursor < hit.cursor) throw new Error('next prompt missing after the abort');
console.log('continue ok: next prompt persisted at cursor ' + again.cursor);
const meta = JSON.parse(fs.readFileSync('${OUT}/meta.json', 'utf8'));
if (meta.openRun !== null) throw new Error('expected no open run, got ' + JSON.stringify(meta.openRun));
console.log('ledger ok: no open run left');
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
