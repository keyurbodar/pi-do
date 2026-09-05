#!/bin/sh
# bg-process.sh — proves background processes: start returns a handle, an
# immediate read shows done:false, kill stops it with {killed:true}, a
# post-kill read is 404 (fail closed), cwd escape is 400, the 64-live cap
# answers 429 with a hint, and bg runs never touch VFS rows.
# Usage: sh verify/bg-process.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/bg-process/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/bg-process"
mkdir -p "${OUT}"

post() {
  node -e "
fetch(process.argv[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[2] })
  .then(async (r) => ({ status: r.status, body: await r.text() }))
  .then((o) => { require('node:fs').writeFileSync(process.argv[3], JSON.stringify(o)); console.log(process.argv[3] + ' status=' + o.status + ' ' + o.body.slice(0, 200)); })
  .catch((e) => { console.error('fetch failed: ' + e.message); process.exit(1); });
" "${BASE}${1}" "${2}" "${OUT}/${3}"
}

get() {
  node -e "
fetch(process.argv[1])
  .then(async (r) => ({ status: r.status, body: await r.text() }))
  .then((o) => { require('node:fs').writeFileSync(process.argv[2], JSON.stringify(o)); console.log(process.argv[2] + ' status=' + o.status + ' ' + o.body.slice(0, 200)); })
  .catch((e) => { console.error('fetch failed: ' + e.message); process.exit(1); });
" "${BASE}${1}" "${OUT}/${2}"
}

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
BG="/workspaces/${WS}/bg"

echo "### 2 start sleep 30 returns a handle"
post "${BG}" '{"command":"sleep 30"}' start.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (typeof b.handle !== 'string' || !b.handle) throw new Error('need { handle }, got ' + o.body);
console.log('start ok: handle=' + b.handle);
" "${OUT}/start.json" || exit 1
H="$(node -p "JSON.parse(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).body).handle" "${OUT}/start.json")"
echo "H=${H}"

echo "### 3 immediate read is partial (done:false)"
get "${BG}?handle=${H}" read-partial.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (b.done !== false) throw new Error('expected { done:false }, got ' + o.body);
console.log('partial ok: still running');
" "${OUT}/read-partial.json" || exit 1

echo "### 4 kill stops it with {killed:true}"
post "${BG}/kill" '{"handle":"'"${H}"'"}' kill.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
if (JSON.parse(o.body).killed !== true) throw new Error('expected {killed:true}, got ' + o.body);
console.log('kill ok');
" "${OUT}/kill.json" || exit 1

echo "### 5 post-kill read is 404 (fail closed)"
get "${BG}?handle=${H}" read-gone.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 404) throw new Error('expected 404, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('fail closed ok: ' + b.error);
" "${OUT}/read-gone.json" || exit 1

echo "### 6 cwd escape is 400 with a hint"
post "${BG}" '{"command":"echo hi","cwd":"/tmp"}' escape.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 400) throw new Error('expected 400, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('escape ok: ' + b.error);
" "${OUT}/escape.json" || exit 1

echo "### 7 the 64-live cap answers 429, then makes room after a kill"
I=1
while [ "${I}" -le 64 ]; do
  post "${BG}" '{"command":"sleep 60"}' "fill-${I}.json" || exit 1
  I="$((I + 1))"
done
node -e "
const fs = require('node:fs');
const handles = [];
for (let i = 1; i <= 64; i++) {
  const o = JSON.parse(fs.readFileSync(process.argv[1] + '/fill-' + i + '.json', 'utf8'));
  if (o.status !== 200) throw new Error('fill-' + i + ': expected 200, got ' + o.status + ' ' + o.body);
  const b = JSON.parse(o.body);
  if (typeof b.handle !== 'string' || !b.handle) throw new Error('fill-' + i + ': need { handle }, got ' + o.body);
  handles.push(b.handle);
}
fs.writeFileSync(process.argv[1] + '/handles.txt', handles.join('\n') + '\n');
console.log('fill ok: 64 running');
" "${OUT}" || exit 1
post "${BG}" '{"command":"echo overflow"}' full.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 429) throw new Error('expected 429, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (typeof b.error !== 'string' || !b.error.includes('bg processes full')) throw new Error('expected cap error, got ' + o.body);
if (typeof b.hint !== 'string') throw new Error('need { error, hint }');
if (!b.error.includes('kill one first') && !b.error.includes('disposed oldest done process')) throw new Error('expected eviction wording, got ' + o.body);
console.log('cap ok: ' + b.error);
" "${OUT}/full.json" || exit 1
FIRST="$(sed -n '1p' "${OUT}/handles.txt")"
echo "FIRST=${FIRST}"
post "${BG}/kill" '{"handle":"'"${FIRST}"'"}' fill-kill-first.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
if (JSON.parse(o.body).killed !== true) throw new Error('expected {killed:true}, got ' + o.body);
console.log('room made ok');
" "${OUT}/fill-kill-first.json" || exit 1
post "${BG}" '{"command":"echo retried"}' retry.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (typeof b.handle !== 'string' || !b.handle) throw new Error('need { handle }, got ' + o.body);
console.log('retry ok: handle=' + b.handle);
" "${OUT}/retry.json" || exit 1
RETRY="$(node -p "JSON.parse(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).body).handle" "${OUT}/retry.json")"
printf '%s\n' "${RETRY}" >> "${OUT}/handles.txt"
while IFS= read -r FH; do
  if [ "${FH}" = "${FIRST}" ]; then continue; fi
  post "${BG}/kill" '{"handle":"'"${FH}"'"}' cleanup.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
if (typeof JSON.parse(o.body).killed !== 'boolean') throw new Error('expected {killed:boolean} for ' + process.argv[2] + ', got ' + o.body);
console.log('cleanup ok for ' + process.argv[2] + ': ' + o.body);
" "${OUT}/cleanup.json" "${FH}" || exit 1
done < "${OUT}/handles.txt"
echo "cleanup ok: pool drained"

echo "### 8 bg runs never touch VFS rows"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
echo "${LS_JSON}"
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const n = Array.isArray(b.entries) ? b.entries.length : -1;
if (n !== 0) throw new Error('expected 0 entries, got ' + n);
console.log('no entries ok');
" "${OUT}/ls.json" || exit 1

echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
