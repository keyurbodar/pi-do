#!/bin/sh
# shell-caps.sh — proves exec session caps: 64 live sessions max, the 65th
# disposes the oldest idle session with a hinted 429; dispose reports
# per-session byte counts; cwd escapes fail closed (per-call and sticky).
# Usage: sh verify/shell-caps.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/shell-caps/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/shell-caps"
mkdir -p "${OUT}"

post() {
  # post <path> <json-body> <outfile>
  node -e "
fetch(process.argv[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[2] })
  .then(async (r) => ({ status: r.status, body: await r.text() }))
  .then((o) => { require('node:fs').writeFileSync(process.argv[3], JSON.stringify(o)); console.log(process.argv[3] + ' status=' + o.status + ' ' + o.body.slice(0, 300)); })
  .catch((e) => { console.error('fetch failed: ' + e.message); process.exit(1); });
" "${BASE}${1}" "${2}" "${OUT}/${3}"
}

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
EXEC="/workspaces/${WS}/exec"
FIRST="cap-1-${RUN_ID}"

echo "### 2 oldest session banks state and bytes"
post "${EXEC}" '{"command":"export MARK='"${RUN_ID}"' && echo payload-'"${RUN_ID}"'","sid":"'"${FIRST}"'"}' first.json || exit 1

echo "### 3 fill to 64 live sessions"
i=2
while [ "${i}" -le 64 ]; do
  post "${EXEC}" '{"command":"echo hi","sid":"cap-'"${i}"'-'"${RUN_ID}"'"}' "fill-${i}.json" || exit 1
  i=$((i + 1))
done
node -e "
const fs = require('node:fs');
for (let i = 2; i <= 64; i++) {
  const o = JSON.parse(fs.readFileSync(process.argv[1] + '/fill-' + i + '.json', 'utf8'));
  if (o.status !== 200) throw new Error('fill ' + i + ': expected 200, got ' + o.status + ' ' + o.body);
}
console.log('64 live ok');
" "${OUT}" || exit 1

echo "### 4 65th disposes oldest-idle with a hinted 429"
post "${EXEC}" '{"command":"echo late","sid":"cap-65-'"${RUN_ID}"'"}' evict.json || exit 1
FIRST="${FIRST}" node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 429) throw new Error('expected 429, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (!String(b.error).includes(process.env.FIRST)) throw new Error('eviction must name oldest-idle ' + process.env.FIRST + ', got ' + o.body);
if (typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('evict ok: ' + b.error);
" "${OUT}/evict.json" || exit 1

echo "### 5 retry succeeds now that room is free"
post "${EXEC}" '{"command":"echo late","sid":"cap-65-'"${RUN_ID}"'"}' retry.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
console.log('retry ok');
" "${OUT}/retry.json" || exit 1

echo "### 6 evicted session is gone (dispose reports zero bytes)"
post "${EXEC}/dispose" '{"sid":"'"${FIRST}"'"}' evicted-dispose.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = JSON.parse(o.body);
if (b.disposed !== true) throw new Error('expected disposed, got ' + o.body);
if (b.stdoutBytes !== 0 || b.stderrBytes !== 0) throw new Error('evicted session must report zero bytes, got ' + o.body);
console.log('evicted dispose ok: bytes zeroed');
" "${OUT}/evicted-dispose.json" || exit 1

echo "### 7 live session dispose reports byte counts (second view on step 2 output)"
post "${EXEC}/dispose" '{"sid":"cap-2-'"${RUN_ID}"'"}' bytes.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = JSON.parse(o.body);
if (b.disposed !== true) throw new Error('expected disposed, got ' + o.body);
if (!(b.stdoutBytes > 0)) throw new Error('expected stdoutBytes > 0, got ' + o.body);
if (typeof b.stderrBytes !== 'number') throw new Error('need stderrBytes number, got ' + o.body);
console.log('bytes ok: stdoutBytes=' + b.stdoutBytes + ' stderrBytes=' + b.stderrBytes);
" "${OUT}/bytes.json" || exit 1

echo "### 8 absolute escape rejected with a hint"
post "${EXEC}" '{"command":"pwd","cwd":"/tmp"}' escape-abs.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 400) throw new Error('expected 400, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('escape-abs ok: ' + b.error);
" "${OUT}/escape-abs.json" || exit 1

echo "### 9 traversal escape rejected with a hint"
post "${EXEC}" '{"command":"pwd","cwd":"/workspace/../tmp"}' escape-dotdot.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 400) throw new Error('expected 400, got ' + o.status + ' ' + o.body);
console.log('escape-dotdot ok');
" "${OUT}/escape-dotdot.json" || exit 1

echo "### 10 sticky cd-escape does not persist (fail-closed second view)"
post "${EXEC}" '{"command":"cd /tmp && pwd","sid":"cap-3-'"${RUN_ID}"'"}' sticky.json || exit 1
post "${EXEC}" '{"command":"pwd","sid":"cap-3-'"${RUN_ID}"'"}' sticky-pwd.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = JSON.parse(o.body);
if (!String(b.stdout).includes('/workspace')) throw new Error('cwd escaped pin: stdout=' + JSON.stringify(b.stdout));
console.log('sticky ok: cwd still ' + b.stdout.trim());
" "${OUT}/sticky-pwd.json" || exit 1

echo "### 11 sessions never touch VFS rows (second view)"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
echo "${LS_JSON}"
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const n = Array.isArray(b.entries) ? b.entries.length : -1;
if (n !== 0) throw new Error('expected 0 entries, got ' + n);
console.log('no entries ok');
" "${OUT}/ls.json" || exit 1
echo "### 12 dispose the fill sessions so later suites inherit an empty pool"
i=1
while [ "${i}" -le 65 ]; do
  post "${EXEC}/dispose" '{"sid":"cap-'"${i}"'-'"${RUN_ID}"'"}' "drop-${i}.json" 2>/dev/null || true
  i=$((i + 1))
done
echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
