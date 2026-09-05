#!/bin/sh
set -u
BASE="${1:-http://127.0.0.1:8789}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/retention-long"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_PROVIDER="opencode-go"
KEYED_MODEL=""
PROMPT="read ${SEED_PATH}, then in one short sentence say what it contains and what 2+3 equals"
record_blocked() {
  node -e "
const fs = require('node:fs');
let b = {};
try { b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch { b = {}; }
const text = JSON.stringify(b).toLowerCase();
if (!/429|403|rate|quota|too many|overloaded|capacity|datapolicy|opt.in|consent/.test(text)) {
  console.error('run failed without a quota/provider-refusal signal: ' + JSON.stringify(b).slice(0, 300));
  process.exit(1);
}
console.log('block signal ok: ' + JSON.stringify(b).slice(0, 300));
" "$1" || exit 1
  printf '%s\n' "blocked: retention proof ($2 keyed turn ${KEYED_PROVIDER}/${KEYED_MODEL} via createAgentSession) refused; cause in $1 (429/quota or 403/opt-in)." > "${OUT}/BLOCKED"
  echo "BLOCKED ${RUN_ID}: retention proof refused, cause recorded in ${OUT}/BLOCKED"
  exit 0
}
{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"
echo "### 2a free slug discovered live, mimo-v2.5 preferred"
${CLI} models --provider "${KEYED_PROVIDER}" --base "${BASE}" --json > "${OUT}/models-slice.json" || exit 1
cat "${OUT}/models-slice.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/models-slice.json', 'utf8'));
const ids = (b.models || []).map((m) => m.id);
const pick = ids.filter((id) => String(id).includes('mimo-v2.5')).sort()[0] || ids.filter((id) => String(id).includes('mimo')).sort()[0];
if (!pick) throw new Error('fail closed: no mimo slug in the ${KEYED_PROVIDER} slice: ' + JSON.stringify(ids));
fs.writeFileSync('${OUT}/slug.txt', pick + '\n');
console.log('slug ok: ${KEYED_PROVIDER}/' + pick);
" || exit 1
KEYED_MODEL="$(cat "${OUT}/slug.txt")"
echo "KEYED_MODEL=${KEYED_MODEL}"

echo "### 2 seed a tiny file for the keyed turns to read"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1

echo "### 3 mint the default session (short retention)"
SHORT_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json 2>"${OUT}/session-short.stderr")" || exit 1
echo "${SHORT_JSON}"
printf '%s' "${SHORT_JSON}" > "${OUT}/session-short.json"
cat "${OUT}/session-short.stderr"
SID_SHORT="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SHORT_JSON}")"
echo "SID_SHORT=${SID_SHORT}"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/session-short.json', 'utf8'));
if (b.retention !== 'short') throw new Error('default mint must echo retention short: ' + JSON.stringify(b));
console.log('mint ok: default session echoes retention short');
" || exit 1
if ! grep -F -q 'short' "${OUT}/session-short.stderr"; then
  echo "session-create pretty print missing short in ${OUT}/session-short.stderr"
  exit 1
fi
echo "mint pretty ok: default session print shows short"

echo "### 4 model switch of the short session to ${KEYED_PROVIDER}/${KEYED_MODEL} (stored, second view)"
SWITCH_SHORT_JSON="$(${CLI} model --ws "${WS}" --sid "${SID_SHORT}" --model "${KEYED_PROVIDER}/${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_SHORT_JSON}"
printf '%s' "${SWITCH_SHORT_JSON}" > "${OUT}/switch-short.json"
META_SHORT_SWITCH_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID_SHORT}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_SHORT_SWITCH_JSON}" > "${OUT}/meta-short-after-switch.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-short-after-switch.json', 'utf8'));
if (!b.model || b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1

echo "### 5 one keyed headless turn on the short session (first of two model turns)"
if ! RUN_SHORT_JSON="$(${CLI} run --ws "${WS}" --sid "${SID_SHORT}" --prompt "${PROMPT}" --base "${BASE}" --json)"; then
  printf '%s' "${RUN_SHORT_JSON:-}" > "${OUT}/run-short-failed.json"
  record_blocked "${OUT}/run-short-failed.json" "short"
fi
echo "${RUN_SHORT_JSON}"
printf '%s' "${RUN_SHORT_JSON}" > "${OUT}/run-short.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-short.json', 'utf8'));
if (!b.runtime || b.runtime.via !== 'createAgentSession') throw new Error('turn did not flow through the factory: ' + JSON.stringify(b.runtime));
if (b.runtime.model !== '${KEYED_MODEL}') throw new Error('turn did not record the keyed model: ' + JSON.stringify(b.runtime));
if (b.runtime.provider !== '${KEYED_PROVIDER}') throw new Error('turn did not record the keyed provider: ' + JSON.stringify(b.runtime));
if (!b.usage || b.usage.retention !== 'short') throw new Error('usage.retention must be short: ' + JSON.stringify(b.usage));
if (typeof b.result !== 'string' || b.result.length === 0) throw new Error('result must be a non-empty string');
console.log('turn ok: keyed ${KEYED_PROVIDER}/${KEYED_MODEL} with usage.retention short');
" || exit 1
node -e "
const fs = require('node:fs');
const src = fs.readFileSync('cli/bin/pi-do.mjs', 'utf8');
const start = src.indexOf('function formatCount(');
const end = src.indexOf('function printEntriesPayload(');
if (start < 0 || end < 0 || end <= start) throw new Error('shipped formatter block not found');
const formatUsageRow = new Function(src.slice(start, end) + '; return formatUsageRow;')();
const b = JSON.parse(fs.readFileSync('${OUT}/run-short.json', 'utf8'));
const line = 'usage ' + formatUsageRow(b.usage);
console.log(line);
if (!line.includes('ret short')) throw new Error('pretty footer missing ret short: ' + line);
console.log('footer ok: pretty usage line shows ret short');
" || exit 1

echo "### 6 mint the long session with --retention long"
LONG_JSON="$(${CLI} session create --ws "${WS}" --retention long --base "${BASE}" --json 2>"${OUT}/session-long.stderr")" || exit 1
echo "${LONG_JSON}"
printf '%s' "${LONG_JSON}" > "${OUT}/session-long.json"
cat "${OUT}/session-long.stderr"
SID_LONG="$(node -p "JSON.parse(process.argv[1]).sessionId" "${LONG_JSON}")"
echo "SID_LONG=${SID_LONG}"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/session-long.json', 'utf8'));
if (b.retention !== 'long') throw new Error('long mint must echo retention long: ' + JSON.stringify(b));
console.log('mint ok: long session echoes retention long');
" || exit 1
if ! grep -F -q 'long' "${OUT}/session-long.stderr"; then
  echo "session-create pretty print missing long in ${OUT}/session-long.stderr"
  exit 1
fi
echo "mint pretty ok: long session print shows long"

echo "### 7 model switch of the long session to ${KEYED_PROVIDER}/${KEYED_MODEL} (stored, second view)"
SWITCH_LONG_JSON="$(${CLI} model --ws "${WS}" --sid "${SID_LONG}" --model "${KEYED_PROVIDER}/${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_LONG_JSON}"
printf '%s' "${SWITCH_LONG_JSON}" > "${OUT}/switch-long.json"
META_LONG_SWITCH_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID_LONG}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_LONG_SWITCH_JSON}" > "${OUT}/meta-long-after-switch.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-long-after-switch.json', 'utf8'));
if (!b.model || b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1

echo "### 8 one keyed headless turn on the long session (second of two model turns)"
if ! RUN_LONG_JSON="$(${CLI} run --ws "${WS}" --sid "${SID_LONG}" --prompt "${PROMPT}" --base "${BASE}" --json)"; then
  printf '%s' "${RUN_LONG_JSON:-}" > "${OUT}/run-long-failed.json"
  record_blocked "${OUT}/run-long-failed.json" "long"
fi
echo "${RUN_LONG_JSON}"
printf '%s' "${RUN_LONG_JSON}" > "${OUT}/run-long.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-long.json', 'utf8'));
if (!b.runtime || b.runtime.via !== 'createAgentSession') throw new Error('turn did not flow through the factory: ' + JSON.stringify(b.runtime));
if (b.runtime.model !== '${KEYED_MODEL}') throw new Error('turn did not record the keyed model: ' + JSON.stringify(b.runtime));
if (b.runtime.provider !== '${KEYED_PROVIDER}') throw new Error('turn did not record the keyed provider: ' + JSON.stringify(b.runtime));
if (!b.usage || b.usage.retention !== 'long') throw new Error('usage.retention must be long: ' + JSON.stringify(b.usage));
if (typeof b.result !== 'string' || b.result.length === 0) throw new Error('result must be a non-empty string');
console.log('turn ok: keyed ${KEYED_PROVIDER}/${KEYED_MODEL} with usage.retention long');
" || exit 1
node -e "
const fs = require('node:fs');
const src = fs.readFileSync('cli/bin/pi-do.mjs', 'utf8');
const start = src.indexOf('function formatCount(');
const end = src.indexOf('function printEntriesPayload(');
if (start < 0 || end < 0 || end <= start) throw new Error('shipped formatter block not found');
const formatUsageRow = new Function(src.slice(start, end) + '; return formatUsageRow;')();
const b = JSON.parse(fs.readFileSync('${OUT}/run-long.json', 'utf8'));
const line = 'usage ' + formatUsageRow(b.usage);
console.log(line);
if (!line.includes('ret long')) throw new Error('pretty footer missing ret long: ' + line);
console.log('footer ok: pretty usage line shows ret long');
" || exit 1

echo "### 9 entries re-read shows both persisted results carry their retention (second view)"
ENTRIES_SHORT_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID_SHORT}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_SHORT_JSON}" > "${OUT}/entries-short.json"
node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries-short.json', 'utf8'));
const results = (replay.entries || []).filter((e) => e.type === 'result');
if (results.length < 1) throw new Error('no result entries persisted (short session)');
const good = results.some((e) => {
  try {
    const body = JSON.parse(e.body);
    return body.usage && body.usage.retention === 'short' && typeof body.result === 'string' && body.result.length > 0;
  } catch { return false; }
});
if (!good) throw new Error('persisted short results miss a non-empty result with usage.retention short');
console.log('entries ok: short result body carries usage.retention short');
" || exit 1
ENTRIES_LONG_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID_LONG}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_LONG_JSON}" > "${OUT}/entries-long.json"
node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries-long.json', 'utf8'));
const results = (replay.entries || []).filter((e) => e.type === 'result');
if (results.length < 1) throw new Error('no result entries persisted (long session)');
const good = results.some((e) => {
  try {
    const body = JSON.parse(e.body);
    return body.usage && body.usage.retention === 'long' && typeof body.result === 'string' && body.result.length > 0;
  } catch { return false; }
});
if (!good) throw new Error('persisted long results miss a non-empty result with usage.retention long');
console.log('entries ok: long result body carries usage.retention long');
" || exit 1

echo "### 10 meta re-read shows each session reports its retention (second view)"
META_SHORT_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID_SHORT}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_SHORT_JSON}" > "${OUT}/meta-short-after-run.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-short-after-run.json', 'utf8'));
if (b.retention !== 'short') throw new Error('short session meta must report retention short: ' + JSON.stringify(b.retention));
console.log('meta ok: short session reports retention short');
" || exit 1
META_LONG_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID_LONG}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_LONG_JSON}" > "${OUT}/meta-long-after-run.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-long-after-run.json', 'utf8'));
if (b.retention !== 'long') throw new Error('long session meta must report retention long: ' + JSON.stringify(b.retention));
console.log('meta ok: long session reports retention long');
" || exit 1
echo "### 10b mint with a bogus retention fails closed (no model turn)"
node -e "
const base = process.argv[1]; const ws = process.argv[2];
fetch(base + '/workspaces/' + encodeURIComponent(ws) + '/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retention: 'forever' }) }).then(async (r) => {
  const b = await r.json();
  if (r.status !== 400 || b.error !== 'bad retention') throw new Error('bogus retention must fail 400 bad retention: ' + r.status + ' ' + JSON.stringify(b));
  console.log('boundary ok: bogus retention rejected 400 bad retention');
}).catch((e) => { console.error(e.message); process.exit(1); });
" "${BASE}" "${WS}" || exit 1


echo "### 11 redaction grep over the artifacts"
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

echo "PASS ${RUN_ID} ws=${WS} short=${SID_SHORT} long=${SID_LONG}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
