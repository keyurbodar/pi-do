#!/bin/sh
# ext-frames.sh — proves extension frames over the existing WS: get_commands
# lists the session's own commands (empty on the first-party host, whose turns
# run extension-free) without persisting entries, one UI question round-trips
# through scripted responses (ask -> answer -> answered, unknown ids get a
# hinted error), a bad fence on a UI frame closes fenced, and a fenced stub
# turn afterwards still lands revision R0+1 (UI frames never rotate the fence;
# Usage: sh verify/ext-frames.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/ext-frames/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/ext-frames"
mkdir -p "${OUT}"
SEED_PATH="seed.txt"
SEED_BODY="seeded-body-${RUN_ID}"
UI_ID="ui-${RUN_ID}"
UI_Q="ext-ui-question-${RUN_ID}"
UI_A="ext-ui-answer-${RUN_ID}"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the stub reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1

echo "### 3 mint a session (fence F0, revision R0)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"
STREAM0="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"

echo "### 4 entries baseline before any extension frame"
ENTRIES0_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES0_JSON}" > "${OUT}/entries0.json"
C0="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/entries0.json','utf8')).entries.length")"
echo "C0=${C0}"

echo "### 5 write the node WS client (global WebSocket, zero deps)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const MODE = process.env.MODE || "commands";
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
const UI_ID = process.env.UI_ID || "ui-1";
const UI_Q = process.env.UI_Q || "question?";
const UI_A = process.env.UI_A || "answer!";
import { writeFileSync } from "node:fs";

const frames = [];
let close = null;
let settled = false;
let answeredSent = false;
let badSent = false;
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2));
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 30000);
const sock = new WebSocket(WS_URL);
const fenced = (frame) => {
  if (FENCE !== undefined) {
    frame.fence = FENCE;
    frame.expected = EXPECTED;
  }
  return frame;
};
sock.onopen = () => {
  if (MODE === "commands") {
    sock.send(JSON.stringify({ get_commands: true }));
  } else if (MODE === "ui") {
    sock.send(JSON.stringify(fenced({ extension_ui_request: true, id: UI_ID, question: UI_Q })));
  } else if (MODE === "uibad") {
    sock.send(JSON.stringify({ extension_ui_request: true, id: `bad-${UI_ID}`, question: "bad?", fence: "dead", expected: 999 }));
  } else if (MODE === "turn") {
    sock.send(JSON.stringify(fenced({ prompt: PROMPT })));
  }
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if (MODE === "commands") {
    if (frame.commands !== undefined) closeAndFinish();
  } else if (MODE === "ui") {
    if (frame.extension_ui_request === true && frame.id === UI_ID && !answeredSent) {
      answeredSent = true;
      sock.send(JSON.stringify(fenced({ extension_ui_response: true, id: UI_ID, response: UI_A })));
    } else if (frame.answered === true && frame.id === UI_ID && !badSent) {
      badSent = true;
      sock.send(JSON.stringify(fenced({ extension_ui_response: true, id: `nope-${UI_ID}`, response: "x" })));
    } else if (frame.error === "unknown ui request") {
      closeAndFinish();
    }
  } else if (MODE === "turn") {
    if (frame.done === true) closeAndFinish();
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

echo "### 6 get_commands lists the session commands and persists nothing"
WS_URL="${STREAM0}" MODE=commands OUTFILE="${OUT}/frames-commands.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames-commands.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-commands.json', 'utf8'));
const got = b.frames.find((f) => f.commands !== undefined);
if (!got) throw new Error('missing {commands} frame');
if (!Array.isArray(got.commands)) throw new Error('{commands} must be an array');
if (got.commands.length !== 0) throw new Error('first-party turns run extension-free; commands must be empty, got ' + JSON.stringify(got.commands));
console.log('commands ok: empty array with the wire shape, matching the session tools');
" || exit 1
ENTRIES_C_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
CC="$(node -p "JSON.parse(process.argv[1]).entries.length" "${ENTRIES_C_JSON}")"
if [ "${CC}" != "${C0}" ]; then
  echo "FAIL get_commands persisted entries: before=${C0} after=${CC}"
  exit 1
fi
echo "read-only ok: entry count still ${C0}"

echo "### 7 UI request round-trips through scripted responses"
WS_URL="${STREAM0}" MODE=ui FENCE="${F0}" EXPECTED="${R0}" UI_ID="${UI_ID}" UI_Q="${UI_Q}" UI_A="${UI_A}" OUTFILE="${OUT}/frames-ui.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames-ui.json"
UI_Q="${UI_Q}" UI_A="${UI_A}" UI_ID="${UI_ID}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-ui.json', 'utf8'));
const frames = b.frames;
const req = frames.find((f) => f.extension_ui_request === true);
if (!req) throw new Error('missing {extension_ui_request} render frame');
if (req.id !== process.env.UI_ID) throw new Error('request id mismatch');
if (req.question !== process.env.UI_Q) throw new Error('request question mismatch');
console.log('ask ok: id=' + req.id);
const ans = frames.find((f) => f.answered === true);
if (!ans || ans.id !== process.env.UI_ID) throw new Error('missing {answered} for the request');
console.log('answer ok: answered id=' + ans.id);
const bad = frames.find((f) => f.error === 'unknown ui request');
if (!bad || typeof bad.hint !== 'string' || bad.hint.length === 0) throw new Error('unknown id must get {error, hint}');
console.log('unknown-id ok: hinted error, never a silent drop');
const reqEntry = frames.find((f) => f.entry && f.entry.type === 'extension_ui_request');
const ansEntry = frames.find((f) => f.entry && f.entry.type === 'extension_ui_response');
if (!reqEntry || !ansEntry) throw new Error('both UI halves must emit {entry} frames');
if (JSON.parse(reqEntry.entry.body).question !== process.env.UI_Q) throw new Error('request entry body mismatch');
if (JSON.parse(ansEntry.entry.body).response !== process.env.UI_A) throw new Error('response entry body mismatch');
if (ansEntry.entry.cursor !== reqEntry.entry.cursor + 1) throw new Error('UI pair must be adjacent cursors');
console.log('entries ok: request cursor ' + reqEntry.entry.cursor + ', response cursor ' + ansEntry.entry.cursor);
" || exit 1

echo "### 8 bad-fence UI frame closes fenced with the hint"
WS_URL="${STREAM0}" MODE=uibad UI_ID="${UI_ID}" OUTFILE="${OUT}/frames-uibad.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames-uibad.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-uibad.json', 'utf8'));
if (!b.close) throw new Error('bad fence must close the socket, never leave it hanging');
if (b.close.code !== 4403) throw new Error('expected close 4403, got ' + b.close.code);
const hint = b.frames.map((f) => (f.error || '') + ' ' + (f.hint || '')).join(' ') + ' ' + (b.close.reason || '');
if (!/Fenced|fence/i.test(hint)) throw new Error('fenced close must carry the hint, got: ' + JSON.stringify(b));
console.log('fence ok: code=4403 hint present');
" || exit 1

echo "### 9 CLI prints both families (print only, raw JSON stdin)"
{
  printf '%s\n' '{"get_commands": true}' "{\"extension_ui_request\": true, \"id\": \"cli-${RUN_ID}\", \"question\": \"cli-q?\"}" "{\"extension_ui_response\": true, \"id\": \"cli-${RUN_ID}\", \"response\": \"cli-a\"}"
  sleep 8
} | node cli/bin/pi-do.mjs stream --ws "${WS}" --sid "${SID}" --base "${BASE}" > "${OUT}/cli-out.txt" 2> "${OUT}/cli-err.txt" &
CLI_PID=$!
sleep 10
kill "${CLI_PID}" 2>/dev/null || true
wait "${CLI_PID}" 2>/dev/null || true
cat "${OUT}/cli-out.txt"
RUN_ID="${RUN_ID}" node -e "
const fs = require('node:fs');
const out = fs.readFileSync('${OUT}/cli-out.txt', 'utf8');
if (!/^commands \(none\)/m.test(out)) throw new Error('CLI must print the empty command list, got:\n' + out);
if (!out.includes('ui-request cli-' + process.env.RUN_ID + ' cli-q?')) throw new Error('CLI must print the UI request');
if (!out.includes('ui-answered cli-' + process.env.RUN_ID)) throw new Error('CLI must print the UI answer');
console.log('cli print ok: commands + ui-request + ui-answered');
" || exit 1

echo "### 10 fenced turn still lands R0+1, entries byte-match and stay gapless"
WS_URL="${STREAM0}" MODE=turn FENCE="${F0}" EXPECTED="${R0}" PROMPT="read ${SEED_PATH}" OUTFILE="${OUT}/frames-turn.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames-turn.json"
SEED_BODY="${SEED_BODY}" R0="${R0}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames-turn.json', 'utf8'));
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error('missing {done}');
if (done.revision !== Number(process.env.R0) + 1) throw new Error('UI frames must not rotate the fence; done revision ' + done.revision);
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('done result missing seeded read');
console.log('resume ok: turn lands revision ' + done.revision + ' on the pre-UI fence');
" || exit 1
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const ui = JSON.parse(fs.readFileSync('${OUT}/frames-ui.json', 'utf8')).frames.filter((f) => f.entry);
const turn = JSON.parse(fs.readFileSync('${OUT}/frames-turn.json', 'utf8')).frames.filter((f) => f.entry);
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const byCursor = new Map(replay.entries.map((e) => [e.cursor, e]));
for (const f of [...ui, ...turn]) {
  const s = byCursor.get(f.entry.cursor);
  if (!s) throw new Error('streamed cursor ' + f.entry.cursor + ' missing from storage');
  if (s.type !== f.entry.type || s.body !== f.entry.body) throw new Error('byte mismatch at cursor ' + f.entry.cursor);
}
console.log('byte-compare ok: ' + (ui.length + turn.length) + ' entry frames match storage re-reads');
const cursors = replay.entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
const types = replay.entries.map((e) => e.type);
const tail = types.slice(-8).join(',');
if (tail !== 'extension_ui_request,extension_ui_response,prompt,toolCall,toolResult,toolCall,toolResult,result') {
  throw new Error('full sequence must end with the UI pair plus one stub turn, got: ' + tail);
}
console.log('sequence ok: ' + cursors.length + ' entries gapless, UI pair plus stub turn at the tail');
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
