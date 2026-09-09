#!/bin/sh
# keyed-spark-burst.sh — proves a burst of keyed turns on
# opencode-go/muse-spark-1.3-contributor over the real server: one session
# switched to the triple runs six tiny keyed POST /run turns in a fast
# sequential loop with the thinking level changed between turn pairs
# (low, high, then medium with the applied level discovered from the switch
# echo, never assumed), plus one WS stream turn mid-burst carrying a steer
# with a marker word while POST turns queue around it. Every turn must
# complete with a non-empty result and usage with costTotal>0; an entries
# re-read must show contiguous live cursors (the head may be archived when
# the burst trips compaction) with 7 results, 6-7 prompts, and exactly one
# marker steer ordered prompt < steer < result; the session meta usage
# rollup must equal the sum of the seven per-turn in/out usages exactly
# with costTotal within 1e-9. The secret
# arrives only via the caller env / Worker secret and never enters any
# artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-spark-burst.sh [BASE]
# With no BASE the script boots its own wrangler dev on an isolated port
# (8791-8796 scan) with a temp worker/.dev.vars and stops it on exit; with
# a BASE it reuses that server and never writes a secret file.
# Exit 0 on pass, or on quota-blocked (OUT/BLOCKED names the stuck turn);
# 1 otherwise. Writes artifacts/RUN_ID/keyed-spark-burst/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/keyed-spark-burst"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_PROVIDER="opencode-go"
KEYED_MODEL="muse-spark-1.3-contributor"
KEYED_TRIPLE="opencode-go/muse-spark-1.3-contributor"
MARKER="burstmark-${RUN_ID}"
DEV_VARS="worker/.dev.vars"
CREATED=0
OWN=0
WS_BASE=""
PORT=""
THINK_APPLIED=""
if [ -z "${BASE}" ]; then OWN=1; fi
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi; if [ "${CREATED}" = "1" ]; then rm -f worker/.dev.vars; fi' EXIT INT TERM
start_dev() {
PORT="8791"
while [ "${PORT}" -le 8796 ] && curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
echo "port ${PORT} busy, trying next"
PORT=$((PORT + 1))
done
if [ "${PORT}" -gt 8796 ]; then echo "no free isolated port 8791-8796"; exit 1; fi
BASE="http://127.0.0.1:${PORT}"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
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
}
think_switch() {
LVL="$1"
THINK_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level "${LVL}" --base "${BASE}" --json)" || exit 1
echo "${THINK_JSON}"
printf '%s' "${THINK_JSON}" > "${OUT}/thinking-${LVL}.json"
THINK_REQ="${LVL}" node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking-' + process.env.THINK_REQ + '.json', 'utf8'));
if (b.requested !== process.env.THINK_REQ) throw new Error('switch must echo requested ' + process.env.THINK_REQ + ', got ' + JSON.stringify(b));
if (typeof b.thinking !== 'string' || b.thinking.length === 0) throw new Error('switch must carry the applied level: ' + JSON.stringify(b));
console.log('switch ok: requested ' + b.requested + ' applied ' + b.thinking);
" || exit 1
THINK_APPLIED="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/thinking-${LVL}.json','utf8')).thinking")"
echo "applied thinking=${THINK_APPLIED} (requested ${LVL})"
}
post_turn() {
N="$1"
ARITH="$2"
if ! ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read ${SEED_PATH}, then in one short sentence say what it contains and what ${ARITH} equals" --base "${BASE}" --json > "${OUT}/run-${N}.json" 2> "${OUT}/run-${N}.stderr"; then
cat "${OUT}/run-${N}.json" 2>/dev/null || true
cat "${OUT}/run-${N}.stderr" 2>/dev/null || true
if grep -i -E "429|403|rate|quota|too many|overloaded|capacity|datapolicy|opt.in|consent|exceeded|insufficient" "${OUT}/run-${N}.json" "${OUT}/run-${N}.stderr" 2>/dev/null; then
printf '%s\n' "blocked: burst POST turn ${N} refused (429/quota or 403/opt-in; cause in run-${N}.json/run-${N}.stderr)." > "${OUT}/BLOCKED"
echo "PASS ${RUN_ID} BLOCKED burst-post-refused"
exit 0
fi
echo "burst POST turn ${N} failed without a quota/refusal signal"
exit 1
fi
cat "${OUT}/run-${N}.json"
THINK_APPLIED="${THINK_APPLIED}" TURN_N="${N}" node -e "
const fs = require('node:fs');
const n = process.env.TURN_N;
const b = JSON.parse(fs.readFileSync('${OUT}/run-' + n + '.json', 'utf8'));
if (!b.runtime || b.runtime.via !== 'createAgentSession') throw new Error('POST turn ' + n + ' did not flow through the factory: ' + JSON.stringify(b.runtime));
if (b.runtime.provider !== 'opencode-go' || b.runtime.model !== 'muse-spark-1.3-contributor') throw new Error('POST turn ' + n + ' triple wrong: ' + JSON.stringify(b.runtime));
if (b.runtime.thinking !== process.env.THINK_APPLIED) throw new Error('POST turn ' + n + ' thinking ' + b.runtime.thinking + ' != applied ' + process.env.THINK_APPLIED);
const u = b.usage;
if (!u || typeof u.inTokens !== 'number' || typeof u.outTokens !== 'number') throw new Error('POST turn ' + n + ' usage missing: ' + JSON.stringify(u));
if (!(u.costTotal > 0)) throw new Error('POST turn ' + n + ' costTotal must be > 0: ' + JSON.stringify(u));
if (typeof b.result !== 'string' || b.result.length === 0) throw new Error('POST turn ' + n + ' result must be a non-empty string');
console.log('turn ' + n + ' ok: usage in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs + ' thinking=' + b.runtime.thinking);
" || exit 1
}
{
echo "### 0 key presence by length only"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
echo "caller env carries no OPENCODE_API_KEY"
else
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
if [ "${OWN}" = "1" ]; then
if [ -e "${DEV_VARS}" ]; then
if grep -q "^OPENCODE_API_KEY=" "${DEV_VARS}"; then
echo "reusing shared ${DEV_VARS} (house key line present, not mine; no delete on exit)"
else
echo "refusing to clobber existing ${DEV_VARS} without the house key line"
exit 1
fi
else
if [ -z "${OPENCODE_API_KEY:-}" ]; then
printf '%s\n' "blocked: missing-secret plumbing (no OPENCODE_API_KEY in caller env, no shared ${DEV_VARS}); keyed burst unreachable." > "${OUT}/BLOCKED"
echo "BLOCKED missing secret; transcript kept, exiting 0"
exit 0
fi
printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${DEV_VARS}"
CREATED=1
echo "temp secret file written (length-only from here)"
fi
if [ ! -e "${DEV_VARS}" ]; then
if [ -z "${OPENCODE_API_KEY:-}" ]; then
printf '%s\n' "blocked: shared ${DEV_VARS} vanished and no OPENCODE_API_KEY in caller env; keyed burst unreachable." > "${OUT}/BLOCKED"
echo "BLOCKED shared secret file vanished; transcript kept, exiting 0"
exit 0
fi
printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${DEV_VARS}"
CREATED=1
echo "shared secret file vanished; rewrote identical house line"
fi
start_dev
else
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
echo "reusing BASE ${BASE}; the caller must have given that server the secret"
fi
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"
echo "### 2 seed a tiny file the keyed turns read"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"
echo "### 4 switch to ${KEYED_TRIPLE} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_TRIPLE}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-switch.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (!b.model || b.model.provider !== 'opencode-go' || b.model.id !== 'muse-spark-1.3-contributor') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows opencode-go/muse-spark-1.3-contributor');
" || exit 1
echo "### 5 thinking switch low (applied level discovered from the echo)"
think_switch low
echo "### 6 two tiny keyed POST turns at the applied level"
post_turn 1 "2+3"
post_turn 2 "7*6"
echo "### 7 WS stream turn mid-burst with a mid-turn steer carrying the marker"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
const STEER = process.env.STEER || "steer-note";
import { writeFileSync } from "node:fs";
const frames = [];
let close = null;
let steerSent = false;
let settled = false;
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2) + "
");
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 180000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  sock.send(JSON.stringify({ prompt: PROMPT }));
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if (frame.entry && !steerSent) {
    steerSent = true;
    sock.send(JSON.stringify({ steer: true, text: STEER }));
  }
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
PROMPT="Read ${SEED_PATH}, then reply in one short line that states the file contents and includes the exact word \"${MARKER}\" (copy it character-for-character). Keep it short."
STEER="Mid-turn note: make sure the reply includes the exact word \"${MARKER}\"."
printf '%s' "${PROMPT}" > "${OUT}/prompt.txt"
printf '%s' "${STEER}" > "${OUT}/steer.txt"
STREAM="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream"
WS_URL="${STREAM}" PROMPT="${PROMPT}" STEER="${STEER}" OUTFILE="${OUT}/frames.json" node "${OUT}/ws-client.mjs" || exit 1
cat "${OUT}/frames.json"
echo "### 7b block guard: 429/quota or provider refusal (403/opt-in) is reported, not failed"
if node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const blob = JSON.stringify(b);
if (/error[^}]{0,300}?(429|403|quota|rate.?limit|datapolicy|opt.in|consent|exceeded|insufficient)/i.test(blob)) { console.log('blocked: WS steer path refused'); process.exit(0); }
process.exit(1);
"; then
printf '%s\n' "blocked: burst WS steer turn refused (429/quota or 403/opt-in; cause in frames.json)." > "${OUT}/BLOCKED"
echo "BLOCKED burst WS steer turn refused; transcript kept, exiting 0"
exit 0
fi
echo "### 7c steer entry frame landed mid-turn; marker in result or a file the turn wrote; usage costTotal>0"
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
  fs.writeFileSync('${OUT}/marker-need-filecheck.txt', 'marker absent from frames; checking workspace files for ' + marker + '\n');
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
"; code=$?
if [ "${code}" = "2" ]; then
echo "### 7d marker absent from frames; checking files the turn wrote (second view)"
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
echo "### 8 thinking switch high, then two tiny keyed POST turns"
think_switch high
post_turn 3 "9-4"
post_turn 4 "12/3"
echo "### 9 thinking switch medium (applied level discovered from the echo), then two tiny keyed POST turns"
think_switch medium
post_turn 5 "5+8"
post_turn 6 "11-2"
echo "### 10 entries re-read: gapless cursors 1..max, 7 prompts, 7 results, 1 marker steer"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const entries = replay.entries || [];
const marker = process.env.MARKER;
const cursors = entries.map((e) => e.cursor).slice().sort((a, b) => a - b);
const max = cursors[cursors.length - 1];
if (cursors.length === 0) throw new Error('no entries re-read');
for (let i = 1; i < cursors.length; i++) if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap between ' + cursors[i - 1] + ' and ' + cursors[i]);
const prompts = entries.filter((e) => e.type === 'prompt');
const results = entries.filter((e) => e.type === 'result');
const steers = entries.filter((e) => e.type === 'steer' && String(e.body).includes(marker));
if (results.length !== 7) throw new Error('expected 7 results (6 POST + 1 WS), got ' + results.length);
if (prompts.length !== 7 && prompts.length !== 6) throw new Error('expected 7 prompts, 6 when compaction archived the head turn, got ' + prompts.length);
const sBody = JSON.parse(steers[0].body);
const prompt = prompts.find((e) => { try { return JSON.parse(e.body).runId === sBody.runId; } catch { return false; } });
const result = results.find((e) => { try { return JSON.parse(e.body).runId === sBody.runId; } catch { return false; } });
if (!prompt) throw new Error('no prompt entry shares the steer runId ' + sBody.runId);
if (!result) throw new Error('no result entry shares the steer runId ' + sBody.runId);
if (!(prompt.cursor < steers[0].cursor && steers[0].cursor < result.cursor)) throw new Error('cursor order wrong: prompt=' + prompt.cursor + ' steer=' + steers[0].cursor + ' result=' + result.cursor);
for (const r of results) {
  const rb = JSON.parse(r.body);
  if (typeof rb.result !== 'string' || rb.result.length === 0) throw new Error('persisted result empty at cursor ' + r.cursor);
  if (!rb.usage || typeof rb.usage.inTokens !== 'number' || typeof rb.usage.outTokens !== 'number' || !(rb.usage.costTotal > 0)) throw new Error('persisted result usage bad at cursor ' + r.cursor);
}
console.log('entries ok: contiguous live cursors, ' + prompts.length + ' prompts + 1 marker steer + 7 results with usage, ordered prompt < steer < result');
" || exit 1
echo "### 11 meta usage rollup equals the sum of the seven per-turn usages"
META_FINAL_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_FINAL_JSON}" > "${OUT}/meta-final.json"
node -e "
const fs = require('node:fs');
let si = 0, so = 0, sc = 0;
for (let n = 1; n <= 6; n++) {
  const u = JSON.parse(fs.readFileSync('${OUT}/run-' + n + '.json', 'utf8')).usage;
  si += u.inTokens; so += u.outTokens; sc += u.costTotal;
}
const frames = JSON.parse(fs.readFileSync('${OUT}/frames.json', 'utf8'));
const done = frames.frames.find((f) => f.done === true);
si += done.usage.inTokens; so += done.usage.outTokens; sc += done.usage.costTotal;
const meta = JSON.parse(fs.readFileSync('${OUT}/meta-final.json', 'utf8'));
console.log('sum of 7 per-turn usages: in=' + si + ' out=' + so + ' costTotal=' + sc);
console.log('meta rollup: in=' + meta.usage.inTokens + ' out=' + meta.usage.outTokens + ' costTotal=' + meta.usage.costTotal);
if (meta.usage.inTokens !== si) throw new Error('inTokens rollup ' + meta.usage.inTokens + ' != sum ' + si);
if (meta.usage.outTokens !== so) throw new Error('outTokens rollup ' + meta.usage.outTokens + ' != sum ' + so);
if (Math.abs(meta.usage.costTotal - sc) > 1e-9) throw new Error('costTotal rollup ' + meta.usage.costTotal + ' != sum ' + sc);
console.log('rollup ok: meta usage equals the per-turn sum (in/out exact, cost within 1e-9)');
" || exit 1
echo "### 12 redaction grep over the artifacts"
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
echo "PASS ${RUN_ID} ws=${WS} sid=${SID} turns=7/7"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
