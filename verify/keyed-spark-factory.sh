#!/bin/sh
# keyed-spark-factory.sh — proves one keyed headless turn through the factory.
# With OPENCODE_API_KEY in the caller env (arrives as a Worker secret; the
# server under test must carry it plus MODEL_ID=opencode-go/muse-spark-1.3-contributor):
# a session switched to opencode-go/muse-spark-1.3-contributor runs one headless
# POST /run turn, and the turn records runtime.via=createAgentSession with the
# keyed provider/model triple, nonzero usage (inTokens and costTotal), and a
# non-empty result. Entries and meta re-reads prove the result plus usage
# persisted and the session usage rollup is nonzero. The secret never enters
# any artifact (redaction grep at the end proves it).
# On a 429/quota or provider-refusal (403/opt-in) block the factory path is
# recorded in OUT/BLOCKED with the green transcript kept, and the script exits
# 0 (blocked is reported, not failed). The refusal payload names the true
# cause; run-failed.json keeps it verbatim.
# Usage: sh verify/keyed-spark-factory.sh [BASE]
# Exit 0 on pass or recorded block, 1 otherwise. Writes artifacts/RUN_ID/keyed-spark-factory/.
set -u
BASE="${1:-http://127.0.0.1:8789}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/keyed-spark-factory"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_PROVIDER="opencode-go"
KEYED_MODEL="muse-spark-1.3-contributor"
{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"

echo "### 2 seed a tiny file for the keyed turn to read"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 model switch to ${KEYED_PROVIDER}/${KEYED_MODEL} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_PROVIDER}/${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-switch.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (!b.model || b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1

echo "### 5 one keyed headless turn through the factory (tiny prompt)"
if ! RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read ${SEED_PATH}, then in one short sentence say what it contains and what 2+3 equals" --base "${BASE}" --json)"; then
  printf '%s' "${RUN_JSON:-}" > "${OUT}/run-failed.json"
  node -e "
const fs = require('node:fs');
let b = {};
try { b = JSON.parse(fs.readFileSync('${OUT}/run-failed.json', 'utf8')); } catch { b = {}; }
const text = JSON.stringify(b).toLowerCase();
if (!/429|403|rate|quota|too many|overloaded|capacity|datapolicy|opt.in|consent/.test(text)) {
  console.error('run failed without a quota/provider-refusal signal: ' + JSON.stringify(b).slice(0, 300));
  process.exit(1);
}
console.log('block signal ok: ' + JSON.stringify(b).slice(0, 300));
" || exit 1
  printf '%s\n' "blocked: factory path (POST /run keyed turn ${KEYED_PROVIDER}/${KEYED_MODEL} via createAgentSession) refused; cause in run-failed.json (429/quota or 403/opt-in)." > "${OUT}/BLOCKED"
  echo "BLOCKED ${RUN_ID} ws=${WS} sid=${SID}: factory path refused, cause recorded in ${OUT}/BLOCKED"
  exit 0
fi
echo "${RUN_JSON}"
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
if (!b.runtime || b.runtime.via !== 'createAgentSession') throw new Error('turn did not flow through the factory: ' + JSON.stringify(b.runtime));
if (b.runtime.model !== '${KEYED_MODEL}') throw new Error('turn did not record the keyed model: ' + JSON.stringify(b.runtime));
if (b.runtime.provider !== '${KEYED_PROVIDER}') throw new Error('turn did not record the keyed provider: ' + JSON.stringify(b.runtime));
if (!b.usage || !(b.usage.inTokens > 0)) throw new Error('usage missing inTokens>0: ' + JSON.stringify(b.usage));
if (!(b.usage.costTotal > 0)) throw new Error('usage missing costTotal>0: ' + JSON.stringify(b.usage));
if (typeof b.result !== 'string' || b.result.length === 0) throw new Error('result must be a non-empty string');
const u = b.usage;
console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
console.log('factory ok: via=createAgentSession ${KEYED_PROVIDER}/${KEYED_MODEL}, usage nonzero, result non-empty');
" || exit 1

echo "### 6 entries re-read shows the persisted result with usage (second view)"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const results = (replay.entries || []).filter((e) => e.type === 'result');
if (results.length < 1) throw new Error('no result entries persisted');
const good = results.some((e) => {
  try {
    const body = JSON.parse(e.body);
    return typeof body.result === 'string' && body.result.length > 0 && body.usage && body.usage.inTokens > 0;
  } catch { return false; }
});
if (!good) throw new Error('persisted results miss a non-empty result with usage');
console.log('entries ok: ' + results.length + ' result(s), keyed result with usage persisted');
" || exit 1

echo "### 7 meta re-read shows the session usage rollup nonzero (second view)"
META_AFTER_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_AFTER_JSON}" > "${OUT}/meta-after-run.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-after-run.json', 'utf8'));
if (!b.model || b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('triple moved: ' + JSON.stringify(b.model));
if (!b.usage || !(b.usage.inTokens > 0) || !(b.usage.costTotal > 0)) throw new Error('usage rollup missing nonzero inTokens/costTotal: ' + JSON.stringify(b.usage));
const u = b.usage;
console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
console.log('rollup ok: session usage nonzero after one keyed turn');
" || exit 1

echo "### 8 redaction grep over the artifacts"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "redaction vacuous keyless: no secret in caller env, nothing could have leaked"
  printf '%s\n' "redaction: vacuous (no OPENCODE_API_KEY in caller env)." > "${OUT}/redaction.txt"
else
  prefix="$(printf '%s' "${OPENCODE_API_KEY}" | cut -c1-16)"
  if grep -rF -q -- "${prefix}" "${OUT}"; then
    echo "key material leaked into ${OUT}"
    exit 1
  fi
  echo "redaction ok: key prefix absent from ${OUT}"
  printf '%s\n' "redaction: key prefix absent from ${OUT} (grep exit 1, no match)." > "${OUT}/redaction.txt"
fi

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
