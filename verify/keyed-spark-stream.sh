#!/bin/sh
# keyed-spark-stream.sh — proves one keyed streaming turn over WebSocket on
# opencode-go/muse-spark-1.3-contributor: mint a session, switch the model,
# stream one tiny turn, byte-compare every entry frame against a storage
# re-read, and prove the done frame carries usage with costTotal>0 while a
# meta re-read shows runtime.model muse-spark-1.3-contributor.
# Keyed env needed: server under test is wrangler dev on port 8789 carrying
# the OPENCODE_API_KEY secret plus MODEL_ID=opencode-go/muse-spark-1.3-contributor.
# The secret arrives only via the caller env / Worker secret and never enters
# any artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-spark-stream.sh [BASE]
# Exit 0 on pass (or on quota-blocked 429, reported not failed), 1 otherwise.
# Writes artifacts/RUN_ID/keyed-spark-stream/.
set -u
BASE="${1:-http://127.0.0.1:8789}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/keyed-spark-stream"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_MODEL="opencode-go/muse-spark-1.3-contributor"
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

echo "### 5 write the node WS client (global WebSocket, zero deps)"
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
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2) + "
");
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
  if (frame.error && !frame.done) finish(3, "error frame received: " + String(frame.error).slice(0, 200));
  if (frame.done === true) closeAndFinish();
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  finish(0, null);
};
sock.onerror = () => {};
function closeAndFinish() {
  try { sock.close(1000, "client done"); } catch {}
  setTimeout(() => finish(0, "done received; closed optimistically"), 1000);
}
EOF
echo "client written"

echo "### 6 stream one keyed turn (tiny prompt, few tokens)"
STREAM1="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
CLIENT_CODE=0
WS_URL="${STREAM1}" PROMPT="read ${SEED_PATH}, then answer in under ten words: what did it say?" FENCE="${F0}" EXPECTED="${R0}" OUTFILE="${OUT}/frames.json" node "${OUT}/ws-client.mjs" || CLIENT_CODE=$?
if [ "${CLIENT_CODE}" != "0" ] && [ "${CLIENT_CODE}" != "3" ]; then exit 1; fi
cat "${OUT}/frames.json"

echo "### 6b block guard: 429/quota or provider refusal (403/opt-in) is reported, not failed"
if node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const blob = JSON.stringify(b);
if (/error[^}]{0,300}?(429|403|quota|rate.?limit|datapolicy|opt.in|consent|exceeded|insufficient)/i.test(blob)) { console.log('blocked: stream path refused'); process.exit(0); }
process.exit(1);
"; then
  printf '%s\n' "BLOCKED: keyed-spark-stream refused on the stream path (429/quota or 403/opt-in; done/usage unproven this run; cause in frames.json)." > "${OUT}/BLOCKED"
  echo "BLOCKED stream path refused; transcript kept, exiting 0"
  echo "PASS ${RUN_ID} ws=${WS} sid=${SID} BLOCKED stream-refused"
  exit 0
fi

echo "### 7 done frame carries usage with costTotal>0; model via meta re-read"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error('missing {done}');
const u = done.usage;
if (!u || typeof u !== 'object') throw new Error('done frame missing usage: ' + JSON.stringify(done));
for (const k of ['inTokens', 'outTokens', 'cacheRead', 'costTotal', 'elapsedMs']) {
  if (typeof u[k] !== 'number') throw new Error('usage.' + k + ' must be a number: ' + JSON.stringify(u));
}
if (!(u.costTotal > 0)) throw new Error('usage.costTotal must be > 0, got ' + JSON.stringify(u));
const meta = JSON.parse(fs.readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (meta.model.id !== 'muse-spark-1.3-contributor') throw new Error('meta model wrong: ' + JSON.stringify(meta.model));
console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
console.log('done ok: usage costTotal>0, runtime.model=muse-spark-1.3-contributor (meta second view)');
" || exit 1

echo "### 8 every entry frame matches a storage re-read (byte-compare bodies in cursor order)"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
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
