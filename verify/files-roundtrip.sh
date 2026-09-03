#!/bin/sh
# files-roundtrip.sh — proves workspace create → files put → get → ls.
# Usage: sh verify/files-roundtrip.sh [BASE]
# Exit 0 on byte-identical round-trip, 1 otherwise. Writes artifacts/RUN_ID/files-roundtrip/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/files-roundtrip"
mkdir -p "${OUT}"
PATH_="verify-${RUN_ID}/hello.txt"
BODY="hello-pi-do-${RUN_ID}"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 files put"
printf '%s' "${BODY}" | ${CLI} files put --ws "${WS}" --path "${PATH_}" --base "${BASE}" --json || exit 1

echo "### 3 files get (second view)"
${CLI} files get --ws "${WS}" --path "${PATH_}" --base "${BASE}" --out "${OUT}/got.bin" || exit 1
printf '%s' "${BODY}" > "${OUT}/want.bin"
cmp "${OUT}/want.bin" "${OUT}/got.bin" || exit 1
echo "bytes identical"

echo "### 4 files ls"
${CLI} files ls --ws "${WS}" --path "verify-${RUN_ID}/" --base "${BASE}" --json || exit 1
echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
