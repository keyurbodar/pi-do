#!/bin/sh
# harness-smoke.sh — proves one headless harness turn: seed a file, run a
# prompt through the CLI, assert the read output plus the bash marker.
# Usage: sh verify/harness-smoke.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/harness-smoke/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/harness-smoke"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
MARKER="harness-bash-ok"

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
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 run one headless turn (body must carry read output plus bash marker)"
RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json)" || exit 1
echo "${RUN_JSON}"
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.result !== 'string') throw new Error('result must be a string');
if (!Array.isArray(b.toolCalls)) throw new Error('toolCalls must be an array');
if (!b.result.includes(process.env.SEED_BODY)) throw new Error('result missing seeded read output');
if (!b.result.includes(process.env.MARKER)) throw new Error('result missing bash marker');
const names = b.toolCalls.map((c) => c.tool).sort().join(',');
if (names !== 'bash,read') throw new Error('expected read+bash toolCalls, got ' + names);
console.log('run body ok: read output + bash marker, 2 tool calls');
" "${OUT}/run.json" || exit 1
echo "### 4b turn flowed through createAgentSession (factory marker, keyless stub)"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (!b.runtime || b.runtime.via !== 'createAgentSession') throw new Error('turn did not flow through the factory: missing runtime.via marker');
if (b.runtime.model !== 'stub') throw new Error('expected keyless stub model, got ' + JSON.stringify(b.runtime.model));
console.log('factory path ok: via=createAgentSession model=stub');
" "${OUT}/run.json" || exit 1

echo "### 5 run wrote no files (second view: only the seed)"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
echo "${LS_JSON}"
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const paths = (b.entries || []).map((e) => e.path);
if (paths.length !== 1 || paths[0] !== 'seed.txt') throw new Error('expected only seed.txt, got ' + JSON.stringify(paths));
console.log('no extra files ok');
" "${OUT}/ls.json" || exit 1

echo "### 6 unknown workspace run is 404 with a hint"
if ${CLI} run --ws "nope-${RUN_ID}" --sid "${SID}" --prompt "hi" --base "${BASE}" --json > "${OUT}/missing-ws.json" 2> "${OUT}/missing-ws.stderr"; then
  echo "expected run against unknown workspace to fail"
  exit 1
fi
cat "${OUT}/missing-ws.json" "${OUT}/missing-ws.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" "${OUT}/missing-ws.json" || exit 1

echo "### 7 unknown session run is 404 with a hint"
if ${CLI} run --ws "${WS}" --sid "nope-${RUN_ID}" --prompt "hi" --base "${BASE}" --json > "${OUT}/missing-sid.json" 2> "${OUT}/missing-sid.stderr"; then
  echo "expected run against unknown session to fail"
  exit 1
fi
cat "${OUT}/missing-sid.json" "${OUT}/missing-sid.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" "${OUT}/missing-sid.json" || exit 1
echo "### 8 bash description names backend limits"
node -e "
const fs = require('node:fs');
const src = fs.readFileSync('packages/pi-cf/src/tools/tools.ts', 'utf8');
const m = src.match(/name: \"bash\"[\s\S]*?description:\s*\"([^\"]+)\"/);
if (!m) throw new Error('bash description not found');
const d = m[1];
for (const s of ['just-bash', '1 MiB', '10s']) if (!d.includes(s)) throw new Error('bash description missing ' + s + ': ' + d);
console.log('description ok: ' + d);
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
