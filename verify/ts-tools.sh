#!/bin/sh
# ts-tools.sh — proves compiler-backed diagnostics plus definition plus
# references over the real path in two layers. Layer 1 (live server): a fresh
# workspace on an isolated wrangler dev holds the seeded verify-ts project,
# re-read over HTTP to prove the bytes the tools touch. Layer 2 (shipped
# code): verify/tools-harness.mjs runs the exact diagnostics plus definition
# plus references modules (plus the real edit tool for the break) workerd
# executes against those live bytes, asserting a clean file diagnoses clean,
# a type error carries its TS code, definition resolves across files,
# references list every site, a broken edit surfaces next call, bad offsets
# and non-TS paths fail closed, and first-query plus follow-up timings land
# in the log. The harness is the lever.
# Usage: sh verify/ts-tools.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/ts-tools/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/ts-tools"
mkdir -p "${OUT}"
OWN=0
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi' EXIT INT TERM
{
if [ -z "${BASE}" ]; then OWN=1; fi
if [ "${OWN}" = "1" ]; then
PORT="8811"
while [ "${PORT}" -le 8820 ] && curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
echo "port ${PORT} busy, trying next"
PORT=$((PORT + 1))
done
if [ "${PORT}" -gt 8820 ]; then echo "no free isolated port 8811-8820"; exit 1; fi
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
echo "### 1 fresh workspace plus seeded project"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' 'export function add(a: number, b: number): number {
  console.log("sum", JSON.stringify({ a, b }));
  const seen = new Map<string, number>();
  seen.set("key", a + b);
  const pending: Promise<Array<number>> = Promise.resolve([seen.get("key") as number]);
  setTimeout(() => {
    void pending;
  }, 0);
  return (Object.keys({ a }) as string[]).length + (seen.get("key") as number);
}' | ${CLI} files put --ws "${WS}" --path "verify-ts/clean.ts" --base "${BASE}" --json || exit 1
printf '%s' 'export const spot: number = "needle-type";' | ${CLI} files put --ws "${WS}" --path "verify-ts/spot.ts" --base "${BASE}" --json || exit 1
printf '%s' 'export function helper(name: string): string {
  return `hi ${name}`;
}' | ${CLI} files put --ws "${WS}" --path "verify-ts/util.ts" --base "${BASE}" --json || exit 1
printf '%s' 'import { helper } from "./util";

export function greet(who: string): string {
  return helper(who);
}' | ${CLI} files put --ws "${WS}" --path "verify-ts/main.ts" --base "${BASE}" --json || exit 1
printf '%s' 'plain notes, not typescript' | ${CLI} files put --ws "${WS}" --path "verify-ts/notes.txt" --base "${BASE}" --json || exit 1
echo "### 2 second view: round-trip the file the edit will break"
${CLI} files get --ws "${WS}" --path "verify-ts/clean.ts" --base "${BASE}" --out "${OUT}/roundtrip.bin" || exit 1
printf '%s' 'export function add(a: number, b: number): number {
  console.log("sum", JSON.stringify({ a, b }));
  const seen = new Map<string, number>();
  seen.set("key", a + b);
  const pending: Promise<Array<number>> = Promise.resolve([seen.get("key") as number]);
  setTimeout(() => {
    void pending;
  }, 0);
  return (Object.keys({ a }) as string[]).length + (seen.get("key") as number);
}' > "${OUT}/roundtrip.want"
cmp "${OUT}/roundtrip.want" "${OUT}/roundtrip.bin" || exit 1
echo "round-trip ok"
echo "### 3 shipped ts tools against the live bytes"
node verify/tools-harness.mjs "${BASE}" "${WS}" "${OUT}" ts > "${OUT}/harness.log" 2>&1 || { echo "harness failed"; cat "${OUT}/harness.log"; exit 1; }
cat "${OUT}/harness.log"
PASSES="$(grep -c '^PASS' "${OUT}/harness.log")"
if [ "${PASSES}" != "7" ]; then echo "expected 7 PASS lines, got ${PASSES}"; exit 1; fi
grep -q '^TIMING ts-first-ms=[0-9][0-9]* ts-followup-ms=[0-9][0-9]*$' "${OUT}/harness.log" || { echo "missing TIMING line"; exit 1; }
echo "harness ok: 7 PASS lines plus timings"
echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
