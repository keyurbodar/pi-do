#!/bin/sh
# tools-search.sh — proves find plus grep over the real path in two layers.
# Layer 1 (live server): a fresh workspace on an isolated wrangler dev holds
# the seeded verify-search tree, re-read over HTTP to prove the bytes the
# tools walk, plus the exec route proving the shell reality the tools assume
# (no node in the isolate, shell exit codes propagate). Layer 2 (shipped
# code): verify/tools-harness.mjs runs the exact find plus grep modules
# workerd executes against those live bytes with the same just-bash
# interpreter, asserting ranked hits, file-line-match output with the
# non-UTF8 skip note, and traversal fail-closed. Keyed model turns are out
# of reach: the caller OPENCODE_API_KEY carries no balance (401
# CreditsError on the gate turn), and the keyless stub only runs read plus
# bash, so no keyless turn can invoke a new tool. The harness is the lever.
# Usage: sh verify/tools-search.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/tools-search/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/tools-search"
mkdir -p "${OUT}"
OWN=0
NEEDLE="needle-search-${RUN_ID}"
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi' EXIT INT TERM
{
if [ -z "${BASE}" ]; then OWN=1; fi
if [ "${OWN}" = "1" ]; then
PORT="8791"
while [ "${PORT}" -le 8800 ] && curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
echo "port ${PORT} busy, trying next"
PORT=$((PORT + 1))
done
if [ "${PORT}" -gt 8800 ]; then echo "no free isolated port 8791-8800"; exit 1; fi
BASE="http://127.0.0.1:${PORT}"
echo "start wrangler dev on isolated port ${PORT}"
(cd worker && exec npx wrangler dev --port "${PORT}" --persist-to "${OUT}/persist" > "${OUT}/wrangler.log" 2>&1) &
echo "$!" > "${OUT}/wrangler.pid"
I=0
while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
I=$((I + 1))
if [ "${I}" -ge 90 ]; then echo "wrangler dev never came up; see ${OUT}/wrangler.log"; exit 1; fi
sleep 2
done
echo "dev up at ${BASE} pid=$(cat "${OUT}/wrangler.pid")"
else
echo "reusing BASE ${BASE}"
fi
echo "### 1 fresh workspace plus seeded tree"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "export const spot = \"${NEEDLE}\";" | ${CLI} files put --ws "${WS}" --path "verify-search/src/app.ts" --base "${BASE}" --json || exit 1
printf '%s' "export const helper = \"${NEEDLE}\";" | ${CLI} files put --ws "${WS}" --path "verify-search/src/util.ts" --base "${BASE}" --json || exit 1
printf '%s' "${NEEDLE} docs" | ${CLI} files put --ws "${WS}" --path "verify-search/README.md" --base "${BASE}" --json || exit 1
printf '\377\376\000needle' | ${CLI} files put --ws "${WS}" --path "verify-search/blob.bin" --base "${BASE}" --json || exit 1
echo "### 2 second view: round-trip plus tree listing"
${CLI} files get --ws "${WS}" --path "verify-search/src/app.ts" --base "${BASE}" --out "${OUT}/roundtrip.bin" || exit 1
printf '%s' "export const spot = \"${NEEDLE}\";" > "${OUT}/roundtrip.want"
cmp "${OUT}/roundtrip.want" "${OUT}/roundtrip.bin" || exit 1
echo "round-trip ok"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "verify-search/" --base "${BASE}" --json)" || exit 1
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/ls.json', 'utf8'));
const paths = (b.entries || []).map((e) => e.path).sort();
const want = ['verify-search/README.md', 'verify-search/blob.bin', 'verify-search/src/app.ts', 'verify-search/src/util.ts'];
if (JSON.stringify(paths) !== JSON.stringify(want)) throw new Error('tree mismatch: ' + JSON.stringify(paths));
console.log('tree ok: 4 seeded entries live');
" || exit 1
echo "### 3 shell reality the tools assume"
${CLI} exec --ws "${WS}" --command "node --version" --base "${BASE}" --json > "${OUT}/no-node.json" || exit 1
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/no-node.json', 'utf8'));
if (b.exit !== 127) throw new Error('expected node absent (127), got ' + JSON.stringify(b));
console.log('shell ok: no node in the isolate, diagnostics stays structural');
" || exit 1
${CLI} exec --ws "${WS}" --command "[ 1 -eq 2 ]" --base "${BASE}" --json > "${OUT}/exit-one.json" || exit 1
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/exit-one.json', 'utf8'));
if (b.exit !== 1) throw new Error('expected exit 1, got ' + JSON.stringify(b));
console.log('shell ok: exit codes propagate through the seam');
" || exit 1
echo "### 4 touched-package typecheck prints nothing"
(cd packages/pi-cf && npx tsc --noEmit) > "${OUT}/tsc.log" 2>&1 || { echo "pi-cf typecheck failed"; cat "${OUT}/tsc.log"; exit 1; }
if [ -s "${OUT}/tsc.log" ]; then echo "typecheck printed output"; cat "${OUT}/tsc.log"; exit 1; fi
echo "typecheck ok: silent"
echo "### 5 shipped find plus grep against the live bytes"
node verify/tools-harness.mjs "${BASE}" "${WS}" "${OUT}" search "${NEEDLE}" > "${OUT}/harness.log" 2>&1 || { echo "harness failed"; cat "${OUT}/harness.log"; exit 1; }
cat "${OUT}/harness.log"
PASSES="$(grep -c '^PASS' "${OUT}/harness.log")"
if [ "${PASSES}" != "5" ]; then echo "expected 5 PASS lines, got ${PASSES}"; exit 1; fi
echo "harness ok: 5 PASS lines"
echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
