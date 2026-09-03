#!/bin/sh
# tools-smoke.sh — proves the file-tool surface live: seed files over HTTP,
# list plus remove over the files surface (file, guarded tree, recursive
# tree, traversal rejection), a write read-back round-trip, then one turn
# whose toolCall/toolResult entries prove mutations record as entries.
# Usage: sh verify/tools-smoke.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/tools-smoke/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/tools-smoke"
mkdir -p "${OUT}"
HELLO_BODY="hello-tools-${RUN_ID}"
DEEP_BODY="deep-tools-${RUN_ID}"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed files over HTTP (write path, live)"
printf '%s' "${HELLO_BODY}" | ${CLI} files put --ws "${WS}" --path "smoke/hello.txt" --base "${BASE}" --json || exit 1
printf '%s' "${DEEP_BODY}" | ${CLI} files put --ws "${WS}" --path "smoke/nested/deep.txt" --base "${BASE}" --json || exit 1
printf 'other' | ${CLI} files put --ws "${WS}" --path "smoke/nested/other.txt" --base "${BASE}" --json || exit 1
printf 'seed' | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1

echo "### 3 write read-back round-trip over HTTP (second view)"
${CLI} files get --ws "${WS}" --path "smoke/hello.txt" --base "${BASE}" --out "${OUT}/got.bin" || exit 1
printf '%s' "${HELLO_BODY}" > "${OUT}/want.bin"
cmp "${OUT}/want.bin" "${OUT}/got.bin" || exit 1
echo "write-then-read ok"

echo "### 4 list over the files surface"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "smoke/" --base "${BASE}" --json)" || exit 1
echo "${LS_JSON}"
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const paths = (b.entries || []).map((e) => e.path).sort();
const want = ['smoke/hello.txt', 'smoke/nested/deep.txt', 'smoke/nested/other.txt'];
if (JSON.stringify(paths) !== JSON.stringify(want)) throw new Error('list mismatch: ' + JSON.stringify(paths));
console.log('list ok: 3 seeded entries');
" "${OUT}/ls.json" || exit 1

echo "### 5 remove one file over the files surface"
RM_JSON="$(${CLI} files rm --ws "${WS}" --path "smoke/hello.txt" --base "${BASE}" --json)" || exit 1
echo "${RM_JSON}"
printf '%s' "${RM_JSON}" > "${OUT}/rm.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (JSON.stringify(b.removed) !== JSON.stringify(['smoke/hello.txt'])) throw new Error('removed mismatch: ' + JSON.stringify(b));
console.log('remove file ok');
" "${OUT}/rm.json" || exit 1
echo "### 5b second view: get is 404, list no longer shows it"
if ${CLI} files get --ws "${WS}" --path "smoke/hello.txt" --base "${BASE}" --out "${OUT}/gone.bin" --json > "${OUT}/gone.json" 2> "${OUT}/gone.stderr"; then
  echo "expected get-after-rm to fail"; exit 1
fi
cat "${OUT}/gone.json" "${OUT}/gone.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('get-after-rm 404 hint ok: ' + b.error);
" "${OUT}/gone.json" || exit 1
LS2_JSON="$(${CLI} files ls --ws "${WS}" --path "smoke/" --base "${BASE}" --json)" || exit 1
printf '%s' "${LS2_JSON}" > "${OUT}/ls2.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const paths = (b.entries || []).map((e) => e.path);
if (paths.includes('smoke/hello.txt')) throw new Error('rm did not stick: ' + JSON.stringify(paths));
console.log('second-view list ok');
" "${OUT}/ls2.json" || exit 1

echo "### 6 guarded tree remove refuses without recursive"
if ${CLI} files rm --ws "${WS}" --path "smoke/nested" --base "${BASE}" --json > "${OUT}/guarded.json" 2> "${OUT}/guarded.stderr"; then
  echo "expected guarded rm to fail"; exit 1
fi
cat "${OUT}/guarded.json" "${OUT}/guarded.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
if (!/recursive/.test(b.hint)) throw new Error('hint must name recursive: ' + b.hint);
console.log('guarded rm ok: ' + b.error);
" "${OUT}/guarded.json" || exit 1

echo "### 7 recursive tree remove clears the subtree"
RMT_JSON="$(${CLI} files rm --ws "${WS}" --path "smoke/nested" --recursive --base "${BASE}" --json)" || exit 1
echo "${RMT_JSON}"
printf '%s' "${RMT_JSON}" > "${OUT}/rmtree.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const got = (b.removed || []).sort();
if (JSON.stringify(got) !== JSON.stringify(['smoke/nested/deep.txt', 'smoke/nested/other.txt'])) throw new Error('tree removed mismatch: ' + JSON.stringify(got));
console.log('recursive rm ok');
" "${OUT}/rmtree.json" || exit 1

echo "### 8 traversal rejected fail-closed over HTTP"
if ${CLI} files rm --ws "${WS}" --path "../escape.txt" --base "${BASE}" --json > "${OUT}/traversal.json" 2> "${OUT}/traversal.stderr"; then
  echo "expected traversal rm to fail"; exit 1
fi
cat "${OUT}/traversal.json" "${OUT}/traversal.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('traversal rejected ok: ' + b.error);
" "${OUT}/traversal.json" || exit 1

echo "### 9 missing remove is 404 with a hint"
if ${CLI} files rm --ws "${WS}" --path "smoke/nested" --base "${BASE}" --json > "${OUT}/missing.json" 2> "${OUT}/missing.stderr"; then
  echo "expected missing rm to fail"; exit 1
fi
cat "${OUT}/missing.json" "${OUT}/missing.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('missing 404 hint ok: ' + b.error);
" "${OUT}/missing.json" || exit 1

echo "### 10 turn records toolCall/toolResult entries (mutations-as-entries path)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"
RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json)" || exit 1
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (!b.result.includes('seed')) throw new Error('turn result missing seeded read output');
if (!Array.isArray(b.toolCalls) || b.toolCalls.length !== 2) throw new Error('expected 2 tool calls');
console.log('turn ok: stub read+bash recorded');
" "${OUT}/run.json" || exit 1
ENT_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${ENT_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const types = (b.entries || []).map((e) => e.type);
for (const t of ['prompt', 'toolCall', 'toolResult', 'result']) {
  if (!types.includes(t)) throw new Error('entries missing ' + t + ': ' + JSON.stringify(types));
}
const bodies = (b.entries || []).map((e) => { try { return JSON.parse(e.body); } catch { return {}; } });
const runIds = new Set(bodies.map((x) => x.runId).filter(Boolean));
if (runIds.size !== 1) throw new Error('one turn must share one runId, got ' + JSON.stringify([...runIds]));
const tools = bodies.filter((x) => x.tool).map((x) => x.tool).sort().join(',');
if (tools !== 'bash,bash,read,read') throw new Error('expected read+bash call+result entries, got ' + tools);
console.log('entries ok: prompt/toolCall/toolResult/result share one runId');
" "${OUT}/entries.json" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
