#!/bin/sh
# keyed-spark-summary.sh — proves the wired summarizer: with a live key, the
# manual compact route persists a compaction entry with summarySource "model"
# whose body follows pi's structured format (## sections), i.e. differs from
# the deterministic "Archived N entries…" summary. Same keyed spark model as
# the keyed-spark-* siblings (opencode-go/muse-spark-1.3-contributor).
# Keyed env needed: with no BASE the script boots its own wrangler dev on an
# isolated port with a temp single-line worker/.dev.vars carrying
# OPENCODE_API_KEY from the caller env; with BASE it reuses that server and
# never writes a secret file. The secret never enters any artifact.
# Usage: sh verify/keyed-spark-summary.sh [BASE]
# Exit 0 on pass, 2 on blocked (BLOCKED names the cause; never PASS); 1 otherwise. Writes artifacts/RUN_ID/keyed-spark-summary/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/keyed-spark-summary"
mkdir -p "${OUT}"
KEYED_PROVIDER="opencode-go"
KEYED_MODEL="muse-spark-1.3-contributor"
DEV_VARS="worker/.dev.vars"
CREATED=0
WS=""
SID=""
if [ -z "${BASE}" ]; then OWN=1; else OWN=0; fi
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi; if [ "${CREATED}" = "1" ]; then rm -f "${DEV_VARS}"; fi' EXIT INT TERM
{
echo "### 0 key presence by length only"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  printf '%s\n' "blocked: OPENCODE_API_KEY absent from caller env; the deterministic path stands and no model summary can be probed." > "${OUT}/BLOCKED"
  echo "BLOCKED ${RUN_ID}: missing OPENCODE_API_KEY, cause recorded in ${OUT}/BLOCKED"
  exit 2
fi
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
if [ "${OWN}" = "1" ]; then
  if [ -e "${DEV_VARS}" ]; then
    printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${OUT}/dev-vars.expect"
    if cmp -s "${OUT}/dev-vars.expect" "${DEV_VARS}"; then
      echo "reusing identical ${DEV_VARS} without ownership"
    else
      echo "refusing to clobber existing ${DEV_VARS}; pass BASE or remove it"
      exit 1
    fi
    rm -f "${OUT}/dev-vars.expect"
  else
    printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${DEV_VARS}"
    CREATED=1
    echo "temp secret file written (length-only from here)"
  fi
  PORT=""
  for P in 8797 8798 8799 8796; do
    if curl -sf --max-time 2 "http://127.0.0.1:${P}/" >/dev/null 2>&1; then
      echo "port ${P} busy, trying next"
    else
      PORT="${P}"
      break
    fi
  done
  if [ -z "${PORT}" ]; then echo "no free isolated port"; exit 1; fi
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
  echo "reusing BASE ${BASE}; the caller must have given that server the secret"
fi

echo "### 1 workspace and session on ${KEYED_PROVIDER}/${KEYED_MODEL}"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"
echo "WS=${WS}"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
echo "SID=${SID}"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_PROVIDER}/${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/switch.json', 'utf8'));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('switch did not echo the triple: ' + JSON.stringify(b.model));
console.log('switch ok: ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1

echo "### 2 two keyed turns seed real content"
for N in 1 2; do
  ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "Reply with exactly one short sentence about a lighthouse keeper. Do not call any tools. Turn ${N}" --base "${BASE}" --json > "${OUT}/turn-${N}.json" 2> "${OUT}/turn-${N}.stderr" || exit 1
  node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/turn-${N}.json', 'utf8'));
if (!b.runtime || b.runtime.provider === 'stub') { require('node:fs').writeFileSync('${OUT}/BLOCKED', 'blocked: turn ${N} stayed on the stub path; the Worker never saw the key.\n'); process.exit(2); }
if (typeof b.result !== 'string' || b.result.length < 4) throw new Error('turn ${N} result too short');
console.log('turn ${N} ok: keyed ' + b.runtime.provider + '/' + b.runtime.model);
" || { RC=$?; [ "${RC}" = "2" ] && echo "BLOCKED ${RUN_ID}: turn stayed stub, cause recorded in ${OUT}/BLOCKED" && exit 2; exit 1; }
done

echo "### 3 top the ledger past the force floor with thinking toggles"
TOG=0
while [ "${TOG}" -lt 60 ]; do
  LIVE="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).entries.length")"
  if [ "${LIVE}" -gt 26 ]; then echo "ledger topped: live=${LIVE} after ${TOG} toggles"; break; fi
  if [ $((TOG % 2)) = "0" ]; then LV="low"; else LV="high"; fi
  ${CLI} thinking --ws "${WS}" --sid "${SID}" --level "${LV}" --base "${BASE}" --json > /dev/null || exit 1
  TOG=$((TOG + 1))
done
LIVE="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).entries.length")"
if [ "${LIVE}" -le 26 ]; then echo "ledger never topped 26, live=${LIVE}"; exit 1; fi

echo "### 4 manual compact: summarySource must be model with a structured body"
${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/compact.json" || exit 1
cat "${OUT}/compact.json"
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-after.json" || exit 1
node -e "
const fs = require('node:fs');
const c = JSON.parse(fs.readFileSync('${OUT}/compact.json', 'utf8'));
if (!c.compacted) throw new Error('manual compact did not fire on 27+ live entries');
if (c.summarySource !== 'model') throw new Error('summarySource ' + c.summarySource + ', want model (keyed provider was on the session)');
const entries = JSON.parse(fs.readFileSync('${OUT}/entries-after.json', 'utf8')).entries;
const summaries = entries.filter((e) => e.type === 'compaction');
if (summaries.length < 1) throw new Error('no compaction entry in the second view');
const body = JSON.parse(summaries[summaries.length - 1].body);
if (!/^## Goal/.test(body.summary.trim()) && !body.summary.includes('## ')) throw new Error('summary is not in pi structured format: ' + body.summary.slice(0, 120));
if (body.summary.startsWith('Archived ')) throw new Error('summary looks deterministic despite summarySource model');
console.log('summary ok: summarySource=model, structured body, cursor ' + summaries[summaries.length - 1].cursor + ', chars ' + body.summary.length);
console.log('PASS ${RUN_ID} keyed-spark-summary: model summary persists and differs from deterministic');
" || exit 1
if grep -q "${OPENCODE_API_KEY}" "${OUT}"/*.json 2>/dev/null; then echo "secret leaked into artifacts"; exit 1; fi
echo "redaction ok: no secret in artifacts"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
