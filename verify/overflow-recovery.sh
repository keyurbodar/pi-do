#!/bin/sh
# overflow-recovery.sh — proves the engine's one-shot context-overflow
# recovery over the real path: a keyed turn whose upstream answers the model
# call with an OpenAI-style overflow 400 ("prompt is too long") is
# force-compacted exactly once (compaction entry persisted) and retried
# once; the retry succeeds and the run completes with the upstream's
# recovery text. The fake upstream (fixtures/overflow-upstream.mjs, a real
# HTTP server speaking openai-completions SSE) 400s exactly the first
# request carrying the OVERFLOW-NOW marker and succeeds on every later
# request, so the run outcome plus the upstream log prove the single
# compact-and-retry. The provider "overflowfake" rides a temp models.json
# (backed up and restored) and a fake key passed as a wrangler --var, so no
# real provider is ever contacted; the session's 26+ entry history is
# seeded by real runs against the same fake provider so the forced
# compaction has a prefix to archive.
# Keyed convention: sources /Users/keyur/Documents/pi-do/worker/.dev.vars;
# without a key the script writes BLOCKED and exits 2 — it never fake-passes.
# Usage: sh verify/overflow-recovery.sh [BASE]
# Exit 0 on pass, 2 on blocked, 1 otherwise. Writes artifacts/RUN_ID/overflow-recovery/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/overflow-recovery"
mkdir -p "${OUT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP_PORT="${UP_PORT:-8899}"
UP_LOG="${OUT}/upstream-requests.log"
: > "${UP_LOG}"

# Keyed convention: a key must exist in the caller env or .dev.vars.
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  . /Users/keyur/Documents/pi-do/worker/.dev.vars 2>/dev/null || true
  export OPENCODE_API_KEY
fi
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "blocked: no provider key in env or worker/.dev.vars; overflow recovery is a keyed path and cannot be proven keyless."
  printf '%s\n' "blocked: no provider key (OPENCODE_API_KEY) in caller env or /Users/keyur/Documents/pi-do/worker/.dev.vars." > "${OUT}/BLOCKED"
  exit 2
fi

MODELS_JSON="${ROOT}/worker/models.json"
cp "${MODELS_JSON}" "${OUT}/models.json.backup" || exit 1

# Worktree discipline: worker/node_modules is a symlink to main's, which
# would resolve pi-cf to the main checkout and prove nothing about this
# branch. Swap in a real node_modules dir mirroring main's entries except
# pi-cf, which points at this worktree; restored on exit.
NM="${ROOT}/worker/node_modules"
NM_MAIN="/Users/keyur/Documents/pi-do/worker/node_modules"
restore_nm() {
  rm -rf "${NM}"
  ln -s "${NM_MAIN}" "${NM}"
}
if [ -L "${NM}" ]; then
  rm "${NM}"
  mkdir "${NM}"
  (cd "${NM_MAIN}" && find . -maxdepth 1 -mindepth 1 -exec ln -s "${NM_MAIN}/{}" "${NM}/{}" \;) || exit 1
  rm -f "${NM}/pi-cf"
  ln -s "${ROOT}/packages/pi-cf" "${NM}/pi-cf" || exit 1
else
  restore_nm() { :; }
fi

restore() {
  mv "${OUT}/models.json.backup" "${MODELS_JSON}" 2>/dev/null
  restore_nm
}
cleanup() {
  restore
  lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
  lsof -ti :8787 | xargs kill 2>/dev/null
  [ -n "${UP_PID:-}" ] && kill "${UP_PID}" 2>/dev/null
  [ -n "${DEV_PID:-}" ] && kill "${DEV_PID}" 2>/dev/null
  pkill -f "wrangler dev --port 8787" 2>/dev/null
  return 0
}
trap 'cleanup' EXIT

{
echo "### 1 fake upstream up"
lsof -ti ":${UP_PORT}" | xargs kill 2>/dev/null
sleep 1
node verify/fixtures/overflow-upstream.mjs "${UP_LOG}" "${UP_PORT}" > /dev/null 2>&1 &
UP_PID=$!
sleep 1
if ! kill -0 "${UP_PID}" 2>/dev/null; then
  echo "FAIL: fake upstream did not start on ${UP_PORT}"
  exit 1
fi
echo "upstream pid ${UP_PID} on ${UP_PORT}"

echo "### 2 temp models.json gains provider overflowfake (contextWindow 200000)"
node -e "
const fs = require('node:fs');
const p = '${MODELS_JSON}';
const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
doc.providers.overflowfake = {
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:${UP_PORT}/v1',
  models: [{ id: 'overflow-1', name: 'Overflow One', api: 'openai-completions', baseUrl: 'http://127.0.0.1:${UP_PORT}/v1', contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
};
fs.writeFileSync(p, JSON.stringify(doc));
console.log('models.json patched');
" || exit 1

echo "### 3 dev server up on 8787 with the fake provider and its key"
(cd "${ROOT}/worker" && exec npx wrangler dev --port 8787 --var OVERFLOWFAKE_API_KEY:overflow-test-key) > "${ROOT}/${OUT}/wrangler-dev.log" 2>&1 &
DEV_PID=$!
READY=0
for i in $(seq 1 90); do
  if curl -s -o /dev/null "${BASE}"; then READY=1; break; fi
  sleep 1
done
if [ "${READY}" != "1" ]; then
  echo "dev server never became ready"
  tail -20 "${ROOT}/${OUT}/wrangler-dev.log"
  exit 1
fi
echo "dev server ready (pid ${DEV_PID})"

echo "### 4 workspace, seed file, session"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf 'seed body for overflow recovery\n' | ${CLI} files put --ws "${WS}" --path seed.txt --base "${BASE}" --json > /dev/null || exit 1
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
printf '%s\n' "WS=${WS} SID=${SID}" > "${OUT}/ids.txt"
echo "SID=${SID}"

echo "### 5 switch the session to overflowfake/overflow-1 (stored, second view)"
${CLI} model --ws "${WS}" --sid "${SID}" --model overflowfake/overflow-1 --base "${BASE}" --json > "${OUT}/model-switch.json" || exit 1
echo "switched"

echo "### 6 build turn history: 14 successful runs (28 entries) so the forced compaction has a prefix"
i=0
while [ "${i}" -lt 14 ]; do
  ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "seed turn ${i}" --base "${BASE}" --json > "${OUT}/seed-run-${i}.json" || exit 1
  i=$((i + 1))
done
echo "14 seed runs done"

echo "### 7 the overflow turn: upstream 400s the marker once, engine force-compacts and retries once"
RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "OVERFLOW-NOW say recovered" --base "${BASE}" --json)" || exit 1
printf '%s' "${RUN_JSON}" > "${OUT}/overflow-run.json"
RESULT_TEXT="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/overflow-run.json', 'utf8')).result")"
echo "run result: ${RESULT_TEXT}"
case "${RESULT_TEXT}" in
  *recovered-ok*) echo "result ok: recovery text present" ;;
  *) echo "FAIL: run result missing recovered-ok: ${RESULT_TEXT}"; exit 1 ;;
esac

echo "### 8 upstream log: exactly one 400 (the marker request), then successes"
cat "${UP_LOG}"
MARKED_400="$(grep -c "marked=true markerServed=false" "${UP_LOG}")"
if [ "${MARKED_400}" != "1" ]; then
  echo "FAIL: expected exactly 1 overflow 400 at the upstream, got ${MARKED_400}"
  exit 1
fi
TOTAL="$(grep -c . "${UP_LOG}")"
if [ "${TOTAL}" -lt 3 ]; then
  echo "FAIL: expected at least 3 upstream hits (overflow, summary/retry), got ${TOTAL}"
  exit 1
fi
echo "hits ok: 1 overflow 400 plus ${TOTAL} total requests (summarizer + retry)"

echo "### 9 second view: exactly one compaction entry, before the run's result"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const entries = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8')).entries || [];
const compactions = entries.filter((e) => e.type === 'compaction');
if (compactions.length !== 1) throw new Error('expected exactly 1 compaction entry, got ' + compactions.length);
const results = entries.filter((e) => e.type === 'result');
const last = results[results.length - 1];
if (!(compactions[0].cursor < last.cursor)) throw new Error('compaction entry must precede the recovered result');
if (!String(last.body).includes('recovered-ok')) throw new Error('recovered result entry missing the recovery text');
console.log('compaction ok: exactly one compaction entry at cursor ' + compactions[0].cursor + ', ordered before the recovered result');
" || exit 1

echo "### 10 redaction grep over the artifacts"
if grep -rF -q -- "overflow-test-key" "${OUT}"; then
  echo "fake key material leaked into ${OUT}"
  exit 1
fi
echo "redaction ok: fake key absent from ${OUT}"

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
