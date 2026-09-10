#!/bin/sh
# keyed-spark-eviction.sh — proves keyed WS turns survive a full workerd eviction mid-turn.
# One session on opencode-go/muse-spark-1.3-contributor under a server this script owns
# (it kill -9s workerd mid-turn, so it must control the pid). Case A starts a long keyed
# WS stream turn, kills -9 wrangler dev mid-turn, reboots on the same port, reconnects
# and retries the prompt: the retry completes on the same chain (same sessionId, cursors
# gapless from 1, two prompts, one result, the killed run healed to interrupted) with
# Any 429/rate/quota/provider-refusal on the keyed path
# writes OUT/BLOCKED naming the stuck turn, keeps the green transcript, stops further
# keyed turns, and exits 0.
# Usage: sh verify/keyed-spark-eviction.sh [BASE]. With no BASE the script boots its own
# wrangler dev on port 8794 (next free in 8791-8796) with a temp worker/.dev.vars holding
# only the OPENCODE_API_KEY line and stops it on exit; with a BASE it takes over that
# port (kill plus own boot on the same port) so both evictions stay under its control,
# and still removes a temp secret file it created on exit.
# Exit 0 on pass (or a named quota/missing-secret block), 1 otherwise. Writes
# artifacts/RUN_ID/keyed-spark-eviction/.
# Wave 2 gap record (recovery scan merged; this script predates it and stays
# unextended by design): case A proves kill plus same-chain retry with the killed
# run healed to interrupted, but it retries immediately after the reboot (no
# orphan-age threshold asserted), never observes attempts (the retry path records
# one pre-redrive; only sigkill-e2e.sh latches it), never touches the poison
# threshold, and never distinguishes continue (contiguous chunks, no attempt) from
# retry (gapped chunks, one attempt) or cursor-pin suffix merges.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/keyed-spark-eviction"
mkdir -p "${OUT}"
KEYED_MODEL="opencode-go/muse-spark-1.3-contributor"
DEV_VARS="worker/.dev.vars"
PORT=""
WS_BASE=""
LONG_A="Write a vivid story of at least 700 words about a lighthouse keeper who discovers a door in the cliff that was never there before. Take your time and be richly detailed: the storm, the light, the door, what lies beyond, and the keeper's choice. Long and vivid."
wait_up() {
I=0
while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
I=$((I + 1))
if [ "${I}" -ge 90 ]; then echo "wrangler dev never came up; see ${OUT}/wrangler.log"; exit 1; fi
sleep 2
done
echo "dev up at ${BASE} pid=$(cat "${OUT}/wrangler.pid")"
}
wait_down() {
I=0
while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
I=$((I + 1))
if [ "${I}" -ge 30 ]; then echo "old dev never released ${BASE}"; exit 1; fi
sleep 1
done
echo "dev down at ${BASE}"
}
launch_dev() {
echo "start wrangler dev on isolated port ${PORT}"
(cd worker && exec npx wrangler dev --port "${PORT}" >> "${OUT}/wrangler.log" 2>&1) &
echo "$!" > "${OUT}/wrangler.pid"
wait_up
}
reap_port() {
if [ -z "${PORT:-}" ] && [ -f "${OUT}/port" ]; then PORT="$(cat "${OUT}/port")"; fi
if [ -z "${PORT:-}" ]; then return 0; fi
if [ -f "${OUT}/wrangler.pid" ]; then kill -9 "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi
rm -f "${OUT}/wrangler.pid"
pkill -9 -f "dev --port ${PORT}" 2>/dev/null || true
I=0
while [ "${I}" -lt 15 ]; do
VICTIMS="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [ -z "${VICTIMS}" ]; then break; fi
kill -9 ${VICTIMS} 2>/dev/null || true
sleep 1
I=$((I + 1))
done
VICTIMS="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [ -n "${VICTIMS}" ]; then echo "port ${PORT} still held by ${VICTIMS}"; return 1; fi
return 0
}
kill_server9() {
reap_port || exit 1
wait_down
}
ensure_secret() {
printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${OUT}/want-dev-vars"
if [ -e "${DEV_VARS}" ]; then
if cmp -s "${OUT}/want-dev-vars" "${DEV_VARS}"; then
echo "secret file already ours (byte-identical); reusing without ownership"
else
echo "refusing to clobber existing ${DEV_VARS}; pass a free BASE or remove it"
exit 1
fi
else
cp "${OUT}/want-dev-vars" "${DEV_VARS}"
touch "${OUT}/created-dev-vars"
echo "temp secret file written (length-only from here)"
fi
rm -f "${OUT}/want-dev-vars"
}
blocked() {
printf '%s\n' "BLOCKED: $1" > "${OUT}/BLOCKED"
echo ""
echo "PASS ${RUN_ID} BLOCKED eviction-refused"
echo "green transcript kept; further keyed turns stopped"
redact || exit 1
exit 0
}
wait_want() {
I=0
while [ "${I}" -lt "$3" ]; do
if FILE="$1" MODE="$2" node "${OUT}/probe.mjs" 2>/dev/null; then echo "hit: $2"; return 0; fi
if FILE="$1" MODE="blocked" node "${OUT}/probe.mjs" 2>/dev/null; then echo "quota"; return 2; fi
if FILE="$1" MODE="over" node "${OUT}/probe.mjs" 2>/dev/null; then echo "over"; return 3; fi
sleep 1
I=$((I + 1))
done
echo "timeout"
return 1
}
redact() {
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
}
trap 'reap_port || true; if [ -f "${OUT}/created-dev-vars" ]; then rm -f worker/.dev.vars; fi' EXIT INT TERM
{
echo "### 0 key presence by length only, lsof required for port-scoped kills"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
echo "caller env carries no OPENCODE_API_KEY"
else
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
command -v lsof >/dev/null 2>&1 || { echo "lsof missing; cannot scope kills to the port"; exit 1; }
if [ -z "${OPENCODE_API_KEY:-}" ]; then
printf '%s\n' "BLOCKED: missing-secret plumbing (no OPENCODE_API_KEY in caller env; keyed eviction unreachable)." > "${OUT}/BLOCKED"
echo "BLOCKED missing secret; transcript kept, exiting 0"
exit 0
fi
if [ -z "${BASE}" ]; then
PORT="8794"
while [ "${PORT}" -le 8796 ] && curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
echo "port ${PORT} busy, trying next"
PORT=$((PORT + 1))
done
if [ "${PORT}" -gt 8796 ]; then echo "no free isolated port 8791-8796"; exit 1; fi
BASE="http://127.0.0.1:${PORT}"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
printf '%s' "${PORT}" > "${OUT}/port"
ensure_secret
launch_dev
else
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
PORT="$(printf '%s' "${BASE}" | sed 's/.*://')"
printf '%s' "${PORT}" > "${OUT}/port"
echo "taking over ${BASE}: evictions need server control, restart reboots this port"
ensure_secret
fi
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
echo "${SWITCH_JSON}"
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
echo "### 4 write the node WS client (incremental frames file) plus the frame probe"
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
const timer = setTimeout(() => finish(1), 240000);
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
  process.exit(/error[^}]{0,300}?(429|403|quota|rate.?limit|exceeded|insufficient|datapolicy|opt.in|consent)/i.test(text) ? 0 : 1);
} else if (mode === "over") {
  process.exit(b.close !== null || frames.some((f) => f.done === true || f.aborted === true || f.error !== undefined) ? 0 : 1);
} else { process.exit(2); }
EOF
echo "client plus probe written"
echo "### 5 case A: start the long keyed stream turn in the background"
STREAM_A="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
WS_URL="${STREAM_A}" PROMPT="${LONG_A}" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames-a1.json" node "${OUT}/ws-client.mjs" &
CLIENT_A="$!"
echo "case A client pid=${CLIENT_A}"
echo "### 6 case A: wait until the turn is in flight, then evict (kill -9 plus reboot, restart 1)"
CODE=0
wait_want "${OUT}/frames-a1.json" "started" 90 || CODE=$?
if [ "${CODE}" = "2" ]; then blocked "case A first turn refused (429/quota or 403/opt-in); cause in frames-a1.json."; fi
if [ "${CODE}" != "0" ]; then echo "case A turn never started (probe=${CODE}); see ${OUT}/frames-a1.json"; kill "${CLIENT_A}" 2>/dev/null || true; exit 1; fi
sleep 3
if FILE="${OUT}/frames-a1.json" MODE="done" node "${OUT}/probe.mjs" 2>/dev/null; then
echo "case A turn finished before the kill; rerun for a true mid-turn eviction"
kill "${CLIENT_A}" 2>/dev/null || true
exit 1
fi
echo "case A in flight; killing -9 the server mid-turn"
kill_server9
launch_dev
echo "restart 1 done: server killed mid-turn and rebooted on ${BASE}"
kill "${CLIENT_A}" 2>/dev/null || true
wait "${CLIENT_A}" 2>/dev/null || true
echo "### 7 case A: meta re-read after eviction proves the chain survived"
META_A_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_A_JSON}" > "${OUT}/meta-a-post.json"
echo "${META_A_JSON}"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-a-post.json', 'utf8'));
if (b.sid !== '${SID}') throw new Error('meta sid moved: ' + b.sid);
if (b.model.provider !== 'opencode-go' || b.model.id !== 'muse-spark-1.3-contributor') throw new Error('triple moved: ' + JSON.stringify(b.model));
console.log('chain ok: same sessionId, triple intact after restart 1');
" || exit 1
echo "### 8 case A: reconnect and retry the same prompt on the same fence"
WS_URL="${STREAM_A}" PROMPT="${LONG_A}" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames-a2.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames-a2.json"
if FILE="${OUT}/frames-a2.json" MODE="blocked" node "${OUT}/probe.mjs" 2>/dev/null; then blocked "case A retry refused (429/quota or 403/opt-in); cause in frames-a2.json."; fi
cat > "${OUT}/assert-a.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const OUT = process.env.OUT;
const R0 = Number(process.env.R0);
const b = JSON.parse(readFileSync(OUT + "/frames-a2.json", "utf8"));
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error("case A retry missing {done}");
if (done.revision !== R0 + 1) throw new Error("case A done revision must be " + (R0 + 1) + ", got " + JSON.stringify(done.revision));
const u = done.usage;
for (const k of ["inTokens", "outTokens", "cacheRead", "costTotal", "elapsedMs"]) {
  if (typeof u[k] !== "number") throw new Error("case A usage." + k + " must be a number: " + JSON.stringify(u));
}
if (!(u.inTokens > 0)) throw new Error("case A usage.inTokens must be > 0");
if (!(u.costTotal > 0)) throw new Error("case A usage.costTotal must be > 0");
if (typeof done.result !== "string" || done.result.length === 0) throw new Error("case A result must be non-empty");
writeFileSync(OUT + "/turn-a.json", JSON.stringify(done, null, 2));
console.log("usage: in=" + u.inTokens + " out=" + u.outTokens + " cacheRead=" + u.cacheRead + " costTotal=" + u.costTotal + " elapsedMs=" + u.elapsedMs);
console.log("retry ok: same fence completed, revision " + R0 + "->" + done.revision + ", result " + done.result.length + " chars");
EOF
OUT="${OUT}" R0="${R0}" node "${OUT}/assert-a.mjs" || exit 1
echo "### 9 case A: entries re-read proves same-chain resume with the killed run healed"
ENTRIES_A_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_A_JSON}" > "${OUT}/entries-a.json"
cat > "${OUT}/assert-chain-a.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const OUT = process.env.OUT;
const replay = JSON.parse(readFileSync(OUT + "/entries-a.json", "utf8"));
const done = JSON.parse(readFileSync(OUT + "/turn-a.json", "utf8"));
const entries = replay.entries;
const cursors = entries.map((e) => e.cursor);
if (cursors[0] !== 1) throw new Error("chain must start at cursor 1, got " + cursors[0]);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error("cursor gap at index " + i);
}
const prompts = entries.filter((e) => e.type === "prompt");
const results = entries.filter((e) => e.type === "result");
const interrupted = entries.filter((e) => e.type === "interrupted");
if (prompts.length !== 2) throw new Error("expected 2 prompts (killed plus retry), got " + prompts.length);
if (results.length !== 1) throw new Error("expected one result for the turn, got " + results.length);
if (interrupted.length !== 1) throw new Error("expected one healed interrupted run, got " + interrupted.length);
const body = JSON.parse(results[0].body);
if (body.result !== done.result) throw new Error("stored result differs from the done frame");
console.log("same-chain ok: " + entries.length + " entries gapless, 2 prompts, one result, 1 interrupted (healed kill)");
EOF
OUT="${OUT}" node "${OUT}/assert-chain-a.mjs" || exit 1
F1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/turn-a.json','utf8')).fence")"
R1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/turn-a.json','utf8')).revision")"
echo "F1=${F1} R1=${R1}"
echo "### 10 case A above is the eviction proof: mid-turn kill plus same-chain retry with usage quoted."
echo "### 11 totals for case A"
node -e "
const fs = require('node:fs');
const a = JSON.parse(fs.readFileSync('${OUT}/turn-a.json', 'utf8')).usage;
const ea = JSON.parse(fs.readFileSync('${OUT}/entries-a.json', 'utf8')).entries.length;
console.log('case A entries=' + ea + ' usage in=' + a.inTokens + ' out=' + a.outTokens + ' costTotal=' + a.costTotal);
" || exit 1
echo "### 12 redaction grep over the artifacts"
echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
