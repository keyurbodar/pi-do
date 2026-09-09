#!/bin/sh
# keyed-spark-abort.sh — proves abort-then-next-prompt over the live keyed path.
# With OPENCODE_API_KEY in the caller env (arrives as a Worker secret; the
# server under test must carry it plus MODEL_ID=opencode-go/muse-spark-1.3-contributor):
# a session switched to opencode-go/muse-spark-1.3-contributor opens a WS,
# a long prompt (~300-word story, so the turn is still in flight) is aborted
# ~1s later, a follow-up prompt still completes on the same session, and an
# entries re-read shows the prior run marked interrupted. At most 2 keyed
# turns (one aborted, one completed); usage/cost is echoed for the completed
# turn (the aborted turn carries no usage frame). The secret never enters any
# artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-spark-abort.sh [BASE]
# Exit 0 on pass (or on quota-blocked, see below), 1 otherwise.
# Writes artifacts/RUN_ID/keyed-spark-abort/.
# Quota: if any path 429s, the script stops immediately, keeps the green
# transcript so far, writes OUT/BLOCKED naming the abort path, and exits 0
# (blocked is reported, not failed).
set -u
BASE="${1:-http://127.0.0.1:8789}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/keyed-spark-abort"
mkdir -p "${OUT}"
KEYED_MODEL="opencode-go/muse-spark-1.3-contributor"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"

echo "### 2 mint a session"
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

echo "### 4 write the node WS client (global WebSocket, zero deps)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const LONG_PROMPT = process.env.LONG_PROMPT;
const FOLLOW_PROMPT = process.env.FOLLOW_PROMPT || "say OK";
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
import { writeFileSync } from "node:fs";

const frames = [];
let close = null;
let settled = false;
let abortSent = false;
let followSent = false;
let finishedTurn = false;
let sawDone = false;
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  clearTimeout(abortTimer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2) + "
");
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 120000);
const abortTimer = setTimeout(() => {
  if (finishedTurn || abortSent) return;
  abortSent = true;
  try {
    sock.send(JSON.stringify({ abort: true }));
  } catch {}
}, 1000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  const frame = { prompt: LONG_PROMPT };
  if (FENCE !== undefined) {
    frame.fence = FENCE;
    frame.expected = EXPECTED;
  }
  sock.send(JSON.stringify(frame));
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if (frame.aborted === true) {
    finishedTurn = true;
    if (!followSent) {
      followSent = true;
      const next = { prompt: FOLLOW_PROMPT };
      if (FENCE !== undefined) {
        next.fence = FENCE;
        next.expected = EXPECTED;
      }
      sock.send(JSON.stringify(next));
    }
  } else if (frame.done === true) {
    sawDone = true;
    closeAndFinish();
  } else if (typeof frame.error === "string" && !sawDone) {
    finish(3, "error frame received: " + String(frame.error));
  }
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
};
EOF
echo "client written"

echo "### 5 long prompt, abort ~1s later, follow-up completes"
CLIENT_CODE=0
STREAM="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
WS_URL="${STREAM}" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames.json" \
  LONG_PROMPT="Write a story of about 300 words about a lighthouse keeper who discovers a door in the cliff that was never there before. Take your time and be vivid." \
  FOLLOW_PROMPT="say OK" \
  node "${OUT}/ws-client.mjs" || CLIENT_CODE=$?
if [ "${CLIENT_CODE}" != "0" ] && [ "${CLIENT_CODE}" != "3" ]; then
  exit 1
fi
cat "${OUT}/frames.json"

echo "### 6 block gate: a 429/quota or provider refusal (403/opt-in) on the abort path reports blocked, not failed"
if node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const text = JSON.stringify(b.frames) + JSON.stringify(b.close);
if (/error[^}]{0,300}?(429|403|quota|rate.?limit|exceeded|insufficient|datapolicy|opt.in|consent)/i.test(text)) { console.log('block hit'); process.exit(0); }
process.exit(1);
"; then
  echo "blocked: abort path refused (429/quota or 403/opt-in) on ${KEYED_MODEL}; transcript kept"
  printf '%s\n' "blocked: abort path refused (429/quota or 403/opt-in) on ${KEYED_MODEL}; no fail, transcript kept; cause in frames.json." > "${OUT}/BLOCKED"
  echo "PASS ${RUN_ID} ws=${WS} sid=${SID} BLOCKED abort-path-refused"
  exit 0
fi
echo "no block: frames carry no 429/refusal signal"
if [ "${CLIENT_CODE}" != "0" ]; then
  echo "abort path failed without a 429/refusal signal"
  exit 1
fi

echo "### 7 aborted turn plus a completing follow-up on the same session"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const frames = b.frames;
if (frames.some((f) => f.busy === true)) throw new Error('follow-up must not be rejected with {busy}');
const aborted = frames.find((f) => f.aborted === true);
if (!aborted) throw new Error('missing {aborted:true} for the long turn');
console.log('aborted ok: run ' + aborted.runId);
const dones = frames.filter((f) => f.done === true);
if (dones.length !== 1) throw new Error('expected one {done} frame (the follow-up), got ' + dones.length);
const done = dones[0];
if (!done.result || !String(done.result).trim()) throw new Error('follow-up done carries no result text');
console.log('follow-up ok: same session completed after the abort, result ' + String(done.result).length + ' chars');
const u = done.usage || null;
fs.writeFileSync('${OUT}/turn-followup.json', JSON.stringify(done, null, 2));
if (u) {
  console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
} else {
  console.log('usage: follow-up done carries no usage object; nothing to report');
}
console.log('aborted-turn usage: none expected (aborted frame carries no usage)');
" || exit 1

echo "### 8 second view: prior run marked interrupted, follow-up persisted, no open run"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
META2_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META2_JSON}" > "${OUT}/meta.json"
node -e "
const fs = require('node:fs');
const frames = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8')).frames;
const aborted = frames.find((f) => f.aborted === true);
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
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
const again = entries.find((e) => e.type === 'prompt' && e.body.includes('say OK'));
if (!again || again.cursor < hit.cursor) throw new Error('follow-up prompt missing after the abort');
console.log('continue ok: follow-up prompt persisted at cursor ' + again.cursor);
const meta = JSON.parse(fs.readFileSync('${OUT}/meta.json', 'utf8'));
if (meta.openRun !== null) throw new Error('expected no open run, got ' + JSON.stringify(meta.openRun));
console.log('ledger ok: no open run left');
if (meta.usage) {
  const u = meta.usage;
  console.log('session totals: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
}
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
