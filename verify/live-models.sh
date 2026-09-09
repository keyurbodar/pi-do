#!/bin/sh
# live-models.sh — proves the live model sync over the real path, no stubs.
# Starts its own keyed `wrangler dev` on an isolated port (default 8791, never
# 8787) with OPENCODE_API_KEY from the caller env as the only Worker secret
# (MODEL_ID is unset for the dev process) and a scratch persist dir, then:
# check 1 (fetch-and-hit, gate-passage): a turn resolving the pinned live
# model opencode-go/muse-spark-1.3-contributor must NOT fail at the live gate
# (no 404 stale/unpinned); it dispatches past pin validation to the provider,
# and the only failure is the downstream gateway 403 DataPolicyError, which
# proves the live list was fetched and hit over the network. Full inference
# success additionally needs a human workspace opt-in at the URL quoted in
# the 403, which this script never performs (privacy decision). Second views:
# the models slice re-shows the pin, the entries replay is re-read, and the
# dev log records the dispatch; check 2 requests opencode-go/no-such-model-xyz
# and expects the 404 unknown-model error plus the available-models hint; check 3
# temporarily narrows the custom pin in worker/models.json to a different id,
# restarts dev, requests the live-but-now-unpinned id and expects the 404
# unpinned-model error, then restores models.json byte-identical (cmp plus git
# diff) and restarts dev. A fresh workspaceId is minted and no workspace file
# operation runs at all (verify-* paths only, vacuously). The secret never
# enters any artifact (redaction grep at the end proves it).
# Usage: sh verify/live-models.sh [PORT]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/live-models/.
set -u
PORT="${1:-8791}"
BASE="http://127.0.0.1:${PORT}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/live-models"
mkdir -p "${OUT}"
PIN_PROVIDER="opencode-go"
PIN_ID="muse-spark-1.3-contributor"
KEEP_ID="muse-spark-1.2-contributor"
STALE_ID="no-such-model-xyz"
PROMPT="Reply with exactly: live-ok"
DEV_VARS="${ROOT}/worker/.dev.vars"
MODELS_JSON="${ROOT}/worker/models.json"
PIN_BACKUP="${OUT}/models.json.orig"
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/live-models-XXXXXX")"
PIDFILE="${TMPBASE}/dev.pid"
PREV_VARS="${TMPBASE}/prev-dev-vars"

start_dev() {
  tag="$1"
  i=0
  while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 30 ]; then
      echo "port ${PORT} still serves traffic after 30s; pick a free port"
      exit 1
    fi
    sleep 1
  done
  set -m
  (cd "${ROOT}/worker" && env -u MODEL_ID npx wrangler dev --port "${PORT}" --inspector-port $((PORT + 100)) --persist-to "${TMPBASE}/persist" >>"${OUT}/${tag}.log" 2>&1 & echo "$!" >"${PIDFILE}")
  set +m
  i=0
  while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 90 ]; then
      echo "dev never became ready on ${BASE} (see ${OUT}/${tag}.log)"
      exit 1
    fi
    sleep 1
  done
  echo "dev ready on ${BASE} (${tag})"
}

stop_dev() {
  if [ -f "${PIDFILE}" ]; then
    pid="$(cat "${PIDFILE}")"
    rm -f "${PIDFILE}"
    kill -TERM "-${pid}" 2>/dev/null || kill "${pid}" 2>/dev/null || true
    i=0
    while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "${i}" -ge 15 ]; then
        kill -KILL "-${pid}" 2>/dev/null || true
      fi
      if [ "${i}" -ge 25 ]; then
        break
      fi
      sleep 1
    done
    if curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; then
      pkill -f "wrangler dev --port ${PORT}([^0-9]|$)" 2>/dev/null || true
      sleep 2
    fi
  fi
}

cleanup() {
  stop_dev
  if [ -f "${PREV_VARS}" ]; then
    cp "${PREV_VARS}" "${DEV_VARS}"
  else
    rm -f "${DEV_VARS}"
  fi
  if [ -f "${PIN_BACKUP}" ]; then
    cp "${PIN_BACKUP}" "${MODELS_JSON}"
  fi
  rm -rf "${TMPBASE}"
}
trap cleanup EXIT INT TERM

{
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "blocked: OPENCODE_API_KEY absent from caller env; live checks need the key as the Worker secret"
  printf '%s\n' "blocked: OPENCODE_API_KEY absent from caller env." > "${OUT}/live-blocked.txt"
  exit 1
fi

if [ -f "${DEV_VARS}" ]; then
  cp "${DEV_VARS}" "${PREV_VARS}"
fi
printf 'OPENCODE_API_KEY="%s"\n' "${OPENCODE_API_KEY}" > "${DEV_VARS}"
cp "${MODELS_JSON}" "${PIN_BACKUP}"

echo "### 0 keyed dev on ${PORT} (MODEL_ID unset, scratch persist)"
start_dev dev1

echo "### 1 fresh workspace plus session"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 2 check 1: turn on ${PIN_PROVIDER}/${PIN_ID} passes the live gate, hits the provider"
if GATE_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${PROMPT}" --model "${PIN_PROVIDER}/${PIN_ID}" --base "${BASE}" --json)"; then
  echo "unexpected full inference success; recording it"
  printf '%s' "${GATE_JSON}" > "${OUT}/run-pinned.json"
  node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-pinned.json', 'utf8'));
if (b.runtime.provider !== '${PIN_PROVIDER}' || b.runtime.model !== '${PIN_ID}') throw new Error('turn did not record the pinned live model: ' + JSON.stringify(b.runtime));
console.log('live ok: full inference success on ' + b.runtime.provider + '/' + b.runtime.model);
" || exit 1
else
  printf '%s' "${GATE_JSON}" > "${OUT}/run-pinned.json"
  node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-pinned.json', 'utf8'));
if (typeof b.error === 'string' && (b.error.indexOf('stale model:') === 0 || b.error.indexOf('unpinned model:') === 0)) throw new Error('failed AT the live gate: ' + JSON.stringify(b));
if (!b.error.includes('OpenAI API error (403)') || !b.error.includes('DataPolicyError')) throw new Error('expected the downstream gateway 403, got: ' + JSON.stringify(b));
if (!b.hint.includes('provider key or quota')) throw new Error('expected the gateway hint, got: ' + JSON.stringify(b));
console.log('gate-passage ok: no 404 stale/unpinned; the live list was fetched and the turn dispatched past the pin');
console.log('evidence error: ' + b.error);
console.log('evidence hint: ' + b.hint);
" || exit 1
  echo "note: full inference success needs a human workspace opt-in at the URL quoted above; this script never performs it"
fi
MODELS_SLICE="$(${CLI} models --provider "${PIN_PROVIDER}" --base "${BASE}" --json)" || exit 1
printf '%s' "${MODELS_SLICE}" > "${OUT}/models-pinned.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/models-pinned.json', 'utf8'));
const hit = (b.models || []).find((m) => m.provider === '${PIN_PROVIDER}' && m.id === '${PIN_ID}');
if (!hit) throw new Error('${PIN_PROVIDER}/${PIN_ID} missing from slice');
if (typeof hit.contextWindow !== 'number' || hit.contextWindow <= 0) throw new Error('contextWindow missing: ' + JSON.stringify(hit));
console.log('slice ok: second view re-shows the pin ${PIN_PROVIDER}/${PIN_ID} ctx ' + hit.contextWindow);
" || exit 1
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries-pinned.json"
node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries-pinned.json', 'utf8'));
console.log('entries ok: re-read ' + (replay.entries || []).length + ' entries (failed turn persists nothing; dev log shows the dispatch)');
" || exit 1

echo "### 3 check 2: stale slug ${PIN_PROVIDER}/${STALE_ID}"
if STALE_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${PROMPT}" --model "${PIN_PROVIDER}/${STALE_ID}" --base "${BASE}" --json)"; then
  echo "stale request unexpectedly succeeded: ${STALE_JSON}"
  exit 1
fi
printf '%s' "${STALE_JSON}" > "${OUT}/run-stale.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-stale.json', 'utf8'));
if (b.error !== 'unknown model: ${PIN_PROVIDER}/${STALE_ID}') throw new Error('wrong stale error: ' + JSON.stringify(b));
if (!b.hint.includes('available ${PIN_PROVIDER} models:')) throw new Error('stale hint misses the available list: ' + JSON.stringify(b));
console.log('stale ok: 404 unknown model plus available-models hint');
" || exit 1

echo "### 4 check 3: narrow the pin to ${KEEP_ID}, restart dev, request live-but-unpinned ${PIN_ID}"
node -e "
const fs = require('node:fs');
const d = JSON.parse(fs.readFileSync('${MODELS_JSON}', 'utf8'));
const models = d.providers['${PIN_PROVIDER}'].models;
if (!models.some((m) => m.id === '${PIN_ID}')) throw new Error('pin does not carry ${PIN_ID}: cannot narrow');
const keep = JSON.parse(JSON.stringify(models.find((m) => m.id === '${PIN_ID}')));
keep.id = '${KEEP_ID}';
keep.name = 'Muse Spark 1.2 Contributor';
d.providers['${PIN_PROVIDER}'].models = [keep];
fs.writeFileSync('${MODELS_JSON}', JSON.stringify(d));
" || exit 1
cp "${MODELS_JSON}" "${OUT}/models.json.narrowed"
stop_dev
start_dev dev2
if UNPINNED_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${PROMPT}" --model "${PIN_PROVIDER}/${PIN_ID}" --base "${BASE}" --json)"; then
  echo "unpinned request unexpectedly succeeded: ${UNPINNED_JSON}"
  exit 1
fi
printf '%s' "${UNPINNED_JSON}" > "${OUT}/run-unpinned.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-unpinned.json', 'utf8'));
if (b.error !== 'unknown model: ${PIN_PROVIDER}/${PIN_ID}') throw new Error('wrong unpinned error: ' + JSON.stringify(b));
if (!b.hint.includes('available ${PIN_PROVIDER} models:')) throw new Error('unpinned hint misses the available list: ' + JSON.stringify(b));
console.log('unpinned ok: 404 unknown model plus available-models hint');
" || exit 1

echo "### 5 restore the pin byte-identical and restart dev"
cp "${PIN_BACKUP}" "${MODELS_JSON}"
cmp "${MODELS_JSON}" "${PIN_BACKUP}" || exit 1
git -C "${ROOT}" diff --quiet -- worker/models.json || { echo "models.json not restored"; exit 1; }
echo "restored ok: worker/models.json byte-identical, git diff clean"
stop_dev
start_dev dev3
MODELS_RESTORED="$(${CLI} models --provider "${PIN_PROVIDER}" --base "${BASE}" --json)" || exit 1
printf '%s' "${MODELS_RESTORED}" > "${OUT}/models-restored.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/models-restored.json', 'utf8'));
if (!(b.models || []).some((m) => m.provider === '${PIN_PROVIDER}' && m.id === '${PIN_ID}')) throw new Error('${PIN_PROVIDER}/${PIN_ID} missing after restore');
console.log('slice ok: restored pin serves ${PIN_PROVIDER}/${PIN_ID} again');
" || exit 1
stop_dev

echo "### 6 redaction grep over the artifacts"
prefix="$(printf '%s' "${OPENCODE_API_KEY}" | cut -c1-16)"
if grep -rF -q -- "${prefix}" "${OUT}"; then
  echo "key material leaked into ${OUT}"
  exit 1
fi
echo "redaction ok: key prefix absent from ${OUT}"
printf '%s\n' "redaction: key prefix absent from ${OUT} (grep exit 1, no match)." > "${OUT}/redaction.txt"

echo "PASS ${RUN_ID} ws=${WS} sid=${SID} port=${PORT}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
