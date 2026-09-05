#!/bin/sh
# tools-ready.sh — proves diagnostics plus test plus pm over the real path in
# two layers. Layer 1 (live server): a fresh workspace on an isolated
# wrangler dev holds the seeded verify-ready project, re-read over HTTP to
# prove the bytes the tools touch. Layer 2 (shipped code):
# verify/tools-harness.mjs runs the exact diagnostics plus test plus pm
# modules (plus the real edit tool for the break) workerd executes against
# those live bytes with the same just-bash interpreter, asserting a clean
# file diagnoses clean, a broken edit surfaces next call, a failing test
# reports FAIL with captured output, and pm run returns a structured result
# naming the seeded lockfile. bg is slipped: start/read/kill needs pollable
# live-process handles the synchronous exec seam cannot offer, so it stays
# out of this bundle. Keyed model turns are out of reach: the caller
# OPENCODE_API_KEY carries no balance (401 CreditsError on the gate turn),
# and the keyless stub only runs read plus bash. The harness is the lever.
# Usage: sh verify/tools-ready.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/tools-ready/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/tools-ready"
mkdir -p "${OUT}"
OWN=0
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
echo "reusing BASE ${BASE}"
fi
echo "### 1 fresh workspace plus seeded project"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' 'export function add(a: number, b: number): number {
  return a + b;
}' | ${CLI} files put --ws "${WS}" --path "verify-ready/app.ts" --base "${BASE}" --json || exit 1
printf '%s' 'echo prove-fail-marker
[ 1 -eq 2 ]' | ${CLI} files put --ws "${WS}" --path "verify-ready/fail.sh" --base "${BASE}" --json || exit 1
printf '%s' '{"name":"verify-ready","scripts":{"test":"echo pm-ran"}}' | ${CLI} files put --ws "${WS}" --path "package.json" --base "${BASE}" --json || exit 1
printf '%s' '{"lockfileVersion":3}' | ${CLI} files put --ws "${WS}" --path "package-lock.json" --base "${BASE}" --json || exit 1
echo "### 2 second view: round-trip the file the edit will break"
${CLI} files get --ws "${WS}" --path "verify-ready/app.ts" --base "${BASE}" --out "${OUT}/roundtrip.bin" || exit 1
printf '%s' 'export function add(a: number, b: number): number {
  return a + b;
}' > "${OUT}/roundtrip.want"
cmp "${OUT}/roundtrip.want" "${OUT}/roundtrip.bin" || exit 1
echo "round-trip ok"
echo "### 3 shipped diagnostics plus test plus pm against the live bytes"
node verify/tools-harness.mjs "${BASE}" "${WS}" "${OUT}" ready > "${OUT}/harness.log" 2>&1 || { echo "harness failed"; cat "${OUT}/harness.log"; exit 1; }
cat "${OUT}/harness.log"
PASSES="$(grep -c '^PASS' "${OUT}/harness.log")"
if [ "${PASSES}" != "6" ]; then echo "expected 6 PASS lines, got ${PASSES}"; exit 1; fi
echo "harness ok: 6 PASS lines"
echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
