#!/bin/sh
# exec-smoke.sh — proves one-off shell exec: echo output plus exit in the
# body, and no entries (files or otherwise) appear for the exec.
# Usage: sh verify/exec-smoke.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/exec-smoke/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/exec-smoke"
mkdir -p "${OUT}"
MARKER="hello-exec-${RUN_ID}"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 exec echo (body must carry stdout plus exit)"
EXEC_JSON="$(${CLI} exec --ws "${WS}" --command "echo ${MARKER}" --base "${BASE}" --json)" || exit 1
echo "${EXEC_JSON}"
printf '%s' "${EXEC_JSON}" > "${OUT}/exec.json"
MARKER="${MARKER}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (b.exit !== 0) throw new Error('expected exit 0, got ' + b.exit);
if (!String(b.stdout).includes(process.env.MARKER)) throw new Error('stdout missing marker');
console.log('exec body ok: stdout carries marker, exit 0');
" "${OUT}/exec.json" || exit 1

echo "### 3 no entries appear for the exec (second view)"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
echo "${LS_JSON}"
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const n = Array.isArray(b.entries) ? b.entries.length : -1;
if (n !== 0) throw new Error('expected 0 entries, got ' + n);
console.log('no entries ok');
" "${OUT}/ls.json" || exit 1

echo "### 4 unknown workspace answers 404 with a hint"
if ${CLI} exec --ws "nope-${RUN_ID}" --command "echo hi" --base "${BASE}" --json > "${OUT}/missing.json" 2> "${OUT}/missing.stderr"; then
  echo "expected exec against unknown workspace to fail"
  exit 1
fi
cat "${OUT}/missing.json" "${OUT}/missing.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" "${OUT}/missing.json" || exit 1

echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
