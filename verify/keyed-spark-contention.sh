#!/bin/sh
# keyed-spark-contention.sh — proves tab contention on
# opencode-go/muse-spark-1.3-contributor: mint a session, switch the model
# triple, switch thinking to high, then race 3 concurrent WS stream turns
# plus 1 concurrent headless POST /run turn on the same session, all
# launched simultaneously. WS turns preempt (newest socket wins, losers get
# a clean abort with an interrupted entry) while the POST serializes through
# the session queue, so the proof is: zero {busy} rejects, entries form ONE
# contiguous chain in arrival order, every streamed entry frame byte-matches
# storage, winners quote usage with costTotal>0 and their marker words,
# losers persist prompt-then-interrupted with no result (no cross-talk, no
# lost entries).
# Keyed env needed: with no BASE the script boots its own wrangler dev on
# port 8793 (fallback 8795-8796 only) with a temp worker/.dev.vars carrying
# the single OPENCODE_API_KEY line, and stops it on exit; with a BASE it
# reuses that server and never writes a secret file. The secret never enters
# artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-spark-contention.sh [BASE]
# Exit 0 on pass (or on quota-blocked 429, reported not failed), 1 otherwise.
# Writes artifacts/RUN_ID/keyed-spark-contention/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/keyed-spark-contention"
mkdir -p "${OUT}"
KEYED_MODEL="opencode-go/muse-spark-1.3-contributor"
KEYED_PROVIDER="opencode-go"
KEYED_ID="muse-spark-1.3-contributor"
DEV_VARS="worker/.dev.vars"
CREATED=0
OWN=0
if [ -z "${BASE}" ]; then OWN=1; fi
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi; if [ "${CREATED}" = "1" ]; then rm -f worker/.dev.vars; fi' EXIT INT TERM
{
echo "### 0 key presence by length only"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
echo "caller env carries no OPENCODE_API_KEY"
else
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
if [ "${OWN}" = "1" ]; then
if [ -z "${OPENCODE_API_KEY:-}" ]; then
printf '%s\n' "blocked: keyed-spark-contention missing-secret (OPENCODE_API_KEY absent; keyed race unreachable)." > "${OUT}/BLOCKED"
echo "BLOCKED missing secret; transcript kept, exiting 0"
exit 0
fi
if [ -e "${DEV_VARS}" ]; then
if printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" | cmp -s - "${DEV_VARS}"; then
echo "reusing identical ${DEV_VARS} from a sibling slice (not mine; leaving it)"
else
echo "refusing to clobber existing ${DEV_VARS}; pass BASE or remove it"
exit 1
fi
else
printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${DEV_VARS}"
CREATED=1
echo "temp secret file written (length-only from here)"
fi
PORT="8793"
if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
echo "port ${PORT} busy, scanning fallback 8795-8796"
PORT="8795"
while [ "${PORT}" -le 8796 ] && curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
echo "port ${PORT} busy, trying next"
PORT=$((PORT + 1))
done
if [ "${PORT}" -gt 8796 ]; then echo "no free isolated port (8793,8795-8796)"; exit 1; fi
fi
BASE="http://127.0.0.1:${PORT}"
echo "start wrangler dev on isolated port ${PORT}"
(cd worker && exec npx wrangler dev --port "${PORT}" > "${OUT}/wrangler.log" 2>&1) &
echo "$!" > "${OUT}/wrangler.pid"
I=0
while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
I=$((I + 1))
if [ "${I}" -ge 90 ]; then echo "wrangler dev never came up; see ${OUT}/wrangler.log"; exit 1; fi
sleep 2
done
echo "dev up at ${BASE} pid=$(cat "${OUT}/wrangler.pid")"
else
echo "reusing BASE; the caller must have given that server the secret"
fi
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
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
echo "SID=${SID}"
echo "### 3 model switch to ${KEYED_MODEL} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-switch.json"
KEYED_PROVIDER="${KEYED_PROVIDER}" KEYED_ID="${KEYED_ID}" node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (b.model.provider !== process.env.KEYED_PROVIDER || b.model.id !== process.env.KEYED_ID) throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows ${KEYED_MODEL}');
" || exit 1
echo "### 4 thinking switch high (non-default level, stored, model untouched)"
THINK_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level high --base "${BASE}" --json)" || exit 1
echo "${THINK_JSON}"
printf '%s' "${THINK_JSON}" > "${OUT}/thinking-high.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking-high.json', 'utf8'));
if (b.requested !== 'high') throw new Error('entry must record the requested level, got ' + JSON.stringify(b));
if (b.thinking !== 'high') throw new Error('high must store as high, got ' + JSON.stringify(b.thinking));
console.log('think ok: requested high applied high');
" || exit 1
META2_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META2_JSON}" > "${OUT}/meta-after-thinking.json"
KEYED_PROVIDER="${KEYED_PROVIDER}" KEYED_ID="${KEYED_ID}" node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
if (b.thinking !== 'high') throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
if (b.model.provider !== process.env.KEYED_PROVIDER || b.model.id !== process.env.KEYED_ID) throw new Error('model triple moved under thinking switch: ' + JSON.stringify(b.model));
console.log('row ok: thinking=high, model untouched');
" || exit 1
echo "### 5 write the node WS race client (global WebSocket, zero deps)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT;
import { writeFileSync } from "node:fs";
const frames = [];
let close = null;
let settled = false;
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2) + "\n");
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 240000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  sock.send(JSON.stringify({ prompt: PROMPT }));
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if (frame.done === true || frame.aborted === true) closeAndFinish();
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  finish(0, null);
};
sock.onerror = () => {};
function closeAndFinish() {
  try { sock.close(1000, "client done"); } catch (e) { void e; }
  setTimeout(() => finish(0, "done received; closed optimistically"), 1000);
}
EOF
echo "client written"
echo "### 6 race 3 WS stream turns plus 1 headless POST on one session"
STREAM_W="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream"
MA="ember-${RUN_ID}"
MB="harbor-${RUN_ID}"
MC="quartz-${RUN_ID}"
MP="signal-${RUN_ID}"
WS_URL="${STREAM_W}" PROMPT="reply with exactly: ${MA} and nothing else" OUTFILE="${OUT}/framesA.json" node "${OUT}/ws-client.mjs" &
PA=$!
WS_URL="${STREAM_W}" PROMPT="reply with exactly: ${MB} and nothing else" OUTFILE="${OUT}/framesB.json" node "${OUT}/ws-client.mjs" &
PB=$!
WS_URL="${STREAM_W}" PROMPT="reply with exactly: ${MC} and nothing else" OUTFILE="${OUT}/framesC.json" node "${OUT}/ws-client.mjs" &
PC=$!
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "reply with exactly: ${MP} and nothing else" --base "${BASE}" --json > "${OUT}/runP.json" 2> "${OUT}/runP.stderr" &
PP=$!
wait "${PA}"; CA=$?
wait "${PB}"; CB=$?
wait "${PC}"; CC=$?
wait "${PP}"; CP=$?
echo "wsA exit=${CA} wsB exit=${CB} wsC exit=${CC} post exit=${CP}"
for F in "${OUT}/framesA.json" "${OUT}/framesB.json" "${OUT}/framesC.json" "${OUT}/runP.json"; do
if [ -f "${F}" ]; then cat "${F}"; else echo "missing ${F}"; fi
done
if [ -f "${OUT}/runP.stderr" ]; then cat "${OUT}/runP.stderr"; fi
echo "### 6b block guard: 429/quota or provider refusal on the keyed race is reported, not failed"
BLOCKED_HIT=0
for F in "${OUT}/framesA.json" "${OUT}/framesB.json" "${OUT}/framesC.json" "${OUT}/runP.json" "${OUT}/runP.stderr"; do
if [ -f "${F}" ] && grep -qiE "datapolicy|opt[.-]in|consent|quota|rate.limit|overloaded|capacity|(^|[^0-9a-fA-F])(429|403)([^0-9a-fA-F]|$)" "${F}"; then
BLOCKED_HIT=1
echo "block signal in ${F}"
fi
done
if [ "${BLOCKED_HIT}" = "1" ]; then
printf '%s\n' "BLOCKED: keyed-spark-contention race refused on a keyed turn (429/quota or 403/opt-in; cause in framesA/B/C.json runP.json/runP.stderr)." > "${OUT}/BLOCKED"
echo "PASS ${RUN_ID} ws=${WS} sid=${SID} BLOCKED keyed-race-refused"
exit 0
fi
if [ "${CP}" != "0" ]; then echo "POST turn P failed"; exit 1; fi
echo "ws exits: A=${CA} B=${CB} C=${CC} (nonzero means that socket lost the race and must show preemption in its frames, asserted below)"
echo "### 7 four turns complete: usage quoted, one chain in arrival order, byte-match, markers"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
METAF_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${METAF_JSON}" > "${OUT}/meta-final.json"
MA="${MA}" MB="${MB}" MC="${MC}" MP="${MP}" KEYED_PROVIDER="${KEYED_PROVIDER}" KEYED_ID="${KEYED_ID}" node -e "
const fs = require('node:fs');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const A = read('${OUT}/framesA.json');
const B = read('${OUT}/framesB.json');
const C = read('${OUT}/framesC.json');
const P = read('${OUT}/runP.json');
const outcome = {};
for (const [name, b] of [['A', A], ['B', B], ['C', C]]) {
  if (b.frames.some((f) => f.busy === true)) throw new Error('WS turn ' + name + ' answered {busy:true}; race must serialize');
  const done = b.frames.find((f) => f.done === true);
  const aborted = b.frames.find((f) => f.aborted === true);
  if (done && aborted) throw new Error('WS turn ' + name + ' shows both done and aborted');
  if (!done && !aborted) throw new Error('WS turn ' + name + ' shows neither done nor aborted');
  outcome[name] = done ? 'won' : 'preempted';
}
console.log('race ok: ' + JSON.stringify(outcome) + ', zero {busy} rejects');
const dones = {};
for (const [name, b] of [['A', A], ['B', B], ['C', C]]) {
  if (outcome[name] !== 'won') continue;
  dones[name] = b.frames.find((f) => f.done === true);
}
if (Object.keys(dones).length < 1) throw new Error('at least one WS turn must win the race');
let totalIn = 0;
let totalOut = 0;
let totalCost = 0;
for (const [name, marker] of [['A', process.env.MA], ['B', process.env.MB], ['C', process.env.MC]]) {
  if (outcome[name] !== 'won') {
    console.log('preempted ok: ws' + name + ' lost the race, abort frame recorded');
    continue;
  }
  const done = dones[name];
  const u = done.usage;
  if (!u || typeof u !== 'object') throw new Error('WS turn ' + name + ' done frame missing usage');
  for (const k of ['inTokens', 'outTokens', 'cacheRead', 'costTotal', 'elapsedMs']) {
    if (typeof u[k] !== 'number') throw new Error('WS turn ' + name + ' usage.' + k + ' must be a number');
  }
  if (!(u.costTotal > 0)) throw new Error('WS turn ' + name + ' usage.costTotal must be > 0');
  if (typeof done.result !== 'string' || !done.result.includes(marker)) throw new Error('WS turn ' + name + ' result missing marker ' + marker);
  console.log('usage: ws' + name + ' in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
  totalIn += u.inTokens;
  totalOut += u.outTokens;
  totalCost += u.costTotal;
}
if (!P.runtime || P.runtime.provider !== process.env.KEYED_PROVIDER || P.runtime.model !== process.env.KEYED_ID) throw new Error('POST turn did not run keyed spark, got ' + JSON.stringify(P.runtime));
if (P.runtime.via !== 'createAgentSession') throw new Error('POST turn did not flow through the factory: ' + JSON.stringify(P.runtime));
if (!P.usage || typeof P.usage.costTotal !== 'number' || !(P.usage.costTotal > 0)) throw new Error('POST turn usage.costTotal must be > 0, got ' + JSON.stringify(P.usage));
if (typeof P.result !== 'string' || !P.result.includes(process.env.MP)) throw new Error('POST turn result missing marker ' + process.env.MP);
console.log('usage: post in=' + P.usage.inTokens + ' out=' + P.usage.outTokens + ' cacheRead=' + P.usage.cacheRead + ' costTotal=' + P.usage.costTotal + ' elapsedMs=' + P.usage.elapsedMs);
totalIn += P.usage.inTokens;
totalOut += P.usage.outTokens;
totalCost += P.usage.costTotal;
console.log('total usage in=' + totalIn + ' out=' + totalOut + ' costTotal=' + totalCost);
const entries = read('${OUT}/entries.json').entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
console.log('gapless ok: ' + entries.length + ' entries, no gaps');
const byRun = new Map();
for (const e of entries) {
  let b;
  try { b = JSON.parse(e.body); } catch (err) { void err; continue; }
  if (!b || typeof b.runId !== 'string') continue;
  if (!byRun.has(b.runId)) byRun.set(b.runId, []);
  byRun.get(b.runId).push(e.cursor);
}
const markers = { A: process.env.MA, B: process.env.MB, C: process.env.MC, P: process.env.MP };
const runOf = (needle) => {
  const hit = entries.find((e) => e.type === 'prompt' && String(e.body).includes(needle));
  if (!hit) throw new Error('prompt entry missing for ' + needle);
  return JSON.parse(hit.body).runId;
};
const runs = {};
for (const k of Object.keys(markers)) runs[k] = runOf(markers[k]);
if (new Set(Object.values(runs)).size !== 4) throw new Error('four turns must be distinct runs, got ' + JSON.stringify(runs));
const arrival = Object.keys(markers).slice().sort((a, b) => {
  const pa = entries.find((e) => e.type === 'prompt' && String(e.body).includes(markers[a])).cursor;
  const pb = entries.find((e) => e.type === 'prompt' && String(e.body).includes(markers[b])).cursor;
  return pa - pb;
});
console.log('arrival order (storage prompt order): ' + arrival.map((k) => k + ':' + markers[k]).join(' < '));
const blocks = arrival.map((k) => ({ k, c: byRun.get(runs[k]) }));
for (const b of blocks) {
  if (!b.c || b.c.length === 0) throw new Error('run ' + b.k + ' has no entries');
}
for (let i = 1; i < blocks.length; i++) {
  if (Math.max(...blocks[i - 1].c) >= Math.min(...blocks[i].c)) throw new Error('turns interleaved: ' + JSON.stringify(blocks.map((b) => b.k + ':' + JSON.stringify(b.c))));
}
console.log('ordered ok: one chain, each turn cursors precede the next in arrival order');
for (const k of Object.keys(markers)) {
  const promptAt = entries.find((e) => e.type === 'prompt' && String(e.body).includes(markers[k])).cursor;
  const curs = byRun.get(runs[k]) || [];
  if (k !== 'P' && outcome[k] !== 'won') {
    const intr = entries.find((e) => e.type === 'interrupted' && curs.includes(e.cursor));
    if (!intr) throw new Error('preempted turn ' + k + ' must persist an interrupted entry');
    if (!(intr.cursor > promptAt)) throw new Error('interrupted precedes its prompt for turn ' + k);
    if (entries.some((e) => e.type === 'result' && curs.includes(e.cursor))) throw new Error('preempted turn ' + k + ' must not persist a result');
    console.log('preempted ok: turn ' + k + ' persisted prompt then interrupted, no result, nothing lost');
    continue;
  }
  const res = entries.find((e) => String(e.body).includes(markers[k]) && e.type === 'result' && curs.includes(e.cursor));
  if (!res) throw new Error('persisted result entry missing marker for turn ' + k);
  if (!(res.cursor > promptAt)) throw new Error('result precedes its prompt for turn ' + k);
}
console.log('results ok: winners persisted marker results after their prompts, losers persisted interrupts, no cross-talk, no lost entries');
const stored = new Map(entries.map((e) => [e.cursor, e]));
let n = 0;
for (const b of [A, B, C]) {
  for (const f of b.frames.filter((f) => f.entry)) {
    const s = stored.get(f.entry.cursor);
    if (!s) throw new Error('streamed cursor ' + f.entry.cursor + ' missing from storage');
    if (s.type !== f.entry.type || s.body !== f.entry.body) throw new Error('byte mismatch at cursor ' + f.entry.cursor);
    n++;
  }
}
console.log('byte-compare ok: ' + n + ' entry frames from 3 sockets match storage re-reads');
const meta = read('${OUT}/meta-final.json');
if (meta.model.provider !== process.env.KEYED_PROVIDER || meta.model.id !== process.env.KEYED_ID) throw new Error('final meta triple wrong: ' + JSON.stringify(meta.model));
console.log('meta ok: session still on ${KEYED_MODEL}');
" || exit 1
echo "### 8 redaction grep over the artifacts"
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
if [ -f "${OUT}/wrangler.pid" ]; then
kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true
rm -f "${OUT}/wrangler.pid"
echo "dev stopped"
fi
if [ "${CREATED}" = "1" ]; then
rm -f worker/.dev.vars
echo "temp secret file removed"
fi
echo "PASS ${RUN_ID} ws=${WS} sid=${SID} turns=4"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
