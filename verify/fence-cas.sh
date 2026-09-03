#!/bin/sh
# fence-cas.sh — proves stale holders never overwrite a live session: mint a
# Usage: sh verify/fence-cas.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/fence-cas/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/fence-cas"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
MARKER="harness-bash-ok"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the stub reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1

echo "### 3 mint a session (fence F0, revision 0)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/session.json', 'utf8'));
if (typeof b.sessionId !== 'string' || !b.sessionId) throw new Error('sessionId missing');
if (typeof b.fence !== 'string' || !b.fence) throw new Error('fence token missing at create');
if (b.revision !== 0) throw new Error('revision must start at 0, got ' + JSON.stringify(b.revision));
console.log('mint ok: fence issued once, revision 0');
" || exit 1

echo "### 4 wrong fence -> 403 Fenced, revision unchanged"
if ${CLI} claim --ws "${WS}" --sid "${SID}" --fence "dead-${RUN_ID}" --expected "${R0}" --base "${BASE}" --json > "${OUT}/bad-fence.json" 2> "${OUT}/bad-fence.stderr"; then
  echo "expected wrong-fence claim to fail"
  exit 1
fi
cat "${OUT}/bad-fence.json" "${OUT}/bad-fence.stderr"
CODE="$(curl -s -o "${OUT}/bad-fence-curl.json" -w "%{http_code}" -X POST "${BASE}/workspaces/${WS}/sessions/${SID}/claim" -H 'content-type: application/json' --data "{\"fence\":\"dead-${RUN_ID}\",\"expected\":${R0}}")"
echo "curl status=${CODE}"
[ "${CODE}" = "403" ] || { echo "expected HTTP 403, got ${CODE}"; exit 1; }
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/bad-fence.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
if (!/Fenced/.test(b.hint)) throw new Error('403 hint must say Fenced, got: ' + b.hint);
if (b.revision !== 0) throw new Error('revision moved on 403, got ' + JSON.stringify(b.revision));
console.log('403 Fenced ok: revision still ' + b.revision);
" || exit 1

echo "### 5 stale revision -> 409 Conflict, fence unrotated"
if ${CLI} claim --ws "${WS}" --sid "${SID}" --fence "${F0}" --expected 999 --base "${BASE}" --json > "${OUT}/stale-rev.json" 2> "${OUT}/stale-rev.stderr"; then
  echo "expected stale-revision claim to fail"
  exit 1
fi
cat "${OUT}/stale-rev.json" "${OUT}/stale-rev.stderr"
CODE="$(curl -s -o "${OUT}/stale-rev-curl.json" -w "%{http_code}" -X POST "${BASE}/workspaces/${WS}/sessions/${SID}/claim" -H 'content-type: application/json' --data "{\"fence\":\"${F0}\",\"expected\":999}")"
echo "curl status=${CODE}"
[ "${CODE}" = "409" ] || { echo "expected HTTP 409, got ${CODE}"; exit 1; }
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/stale-rev.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
if (!/Conflict/.test(b.hint)) throw new Error('409 hint must say Conflict, got: ' + b.hint);
if (b.revision !== 0) throw new Error('revision moved on 409, got ' + JSON.stringify(b.revision));
if (!/0/.test(b.hint)) throw new Error('409 hint must name the current revision 0, got: ' + b.hint);
console.log('409 Conflict ok: revision still 0, fence check passed so F0 unrotated');
" || exit 1

echo "### 6 clean claim (F0, 0) -> fence rotates, revision bumps"
CLAIM_JSON="$(${CLI} claim --ws "${WS}" --sid "${SID}" --fence "${F0}" --expected 0 --base "${BASE}" --json)" || exit 1
echo "${CLAIM_JSON}"
printf '%s' "${CLAIM_JSON}" > "${OUT}/claim.json"
F1="$(node -p "JSON.parse(process.argv[1]).fence" "${CLAIM_JSON}")"
R1="$(node -p "JSON.parse(process.argv[1]).revision" "${CLAIM_JSON}")"
echo "F1=${F1} R1=${R1}"
F0="${F0}" F1="${F1}" R1="${R1}" node -e "
if (!process.env.F1 || process.env.F1 === process.env.F0) throw new Error('fence must rotate on claim');
if (Number(process.env.R1) !== 1) throw new Error('revision must bump 0->1, got ' + process.env.R1);
console.log('claim ok: fence rotated, revision 0->1');
" || exit 1

echo "### 7 run with the OLD fence -> 403, entries byte-identical"
ENTRIES_BEFORE="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_BEFORE}" > "${OUT}/entries-before.json"
if ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --fence "${F0}" --expected "${R1}" --base "${BASE}" --json > "${OUT}/run-old.json" 2> "${OUT}/run-old.stderr"; then
  echo "expected run with old fence to fail"
  exit 1
fi
cat "${OUT}/run-old.json" "${OUT}/run-old.stderr"
CODE="$(curl -s -o "${OUT}/run-old-curl.json" -w "%{http_code}" -X POST "${BASE}/workspaces/${WS}/sessions/${SID}/run" -H 'content-type: application/json' --data "{\"prompt\":\"read seed.txt\",\"fence\":\"${F0}\",\"expected\":${R1}}")"
echo "curl status=${CODE}"
[ "${CODE}" = "403" ] || { echo "expected HTTP 403, got ${CODE}"; exit 1; }
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-old.json', 'utf8'));
if (!/Fenced/.test(b.hint || '')) throw new Error('run 403 hint must say Fenced, got: ' + JSON.stringify(b));
console.log('run 403 Fenced ok: ' + b.error);
" || exit 1
ENTRIES_AFTER_FAIL="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_AFTER_FAIL}" > "${OUT}/entries-after-fail.json"
node -e "
const fs = require('node:fs');
const a = JSON.parse(fs.readFileSync('${OUT}/entries-before.json', 'utf8'));
const b = JSON.parse(fs.readFileSync('${OUT}/entries-after-fail.json', 'utf8'));
if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('403 run mutated entries');
console.log('byte-identical ok: 403 run wrote no entries (' + (a.entries || []).length + ' entries both reads)');
" || exit 1

echo "### 8 run with the NEW fence -> turn executes, fence rotates again"
RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --fence "${F1}" --expected "${R1}" --base "${BASE}" --json)" || exit 1
echo "${RUN_JSON}"
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
F2="$(node -p "JSON.parse(process.argv[1]).fence" "${RUN_JSON}")"
R2="$(node -p "JSON.parse(process.argv[1]).revision" "${RUN_JSON}")"
echo "F2=${F2} R2=${R2}"
SEED_BODY="${SEED_BODY}" MARKER="${MARKER}" F1="${F1}" F2="${F2}" R2="${R2}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
if (typeof b.result !== 'string') throw new Error('result must be a string');
if (!b.result.includes(process.env.SEED_BODY)) throw new Error('result missing seeded read output');
if (!b.result.includes(process.env.MARKER)) throw new Error('result missing bash marker');
if (!Array.isArray(b.toolCalls)) throw new Error('toolCalls must be an array');
if (!process.env.F2 || process.env.F2 === process.env.F1) throw new Error('run must rotate the fence');
if (Number(process.env.R2) !== 2) throw new Error('revision must bump 1->2, got ' + process.env.R2);
console.log('fenced run ok: turn executed, fence rotated, revision 1->2');
" || exit 1

echo "### 9 second view: entries persist the fenced turn"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
echo "${ENTRIES_JSON}"
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const run = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const entries = replay.entries;
if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries must persist the turn');
const want = (run.toolCalls || []).map((c) => c.id).sort();
const got = entries.filter((e) => e.type === 'toolCall').map((e) => JSON.parse(e.body).id).sort();
if (JSON.stringify(want) !== JSON.stringify(got)) {
  throw new Error('toolCall id mismatch: run ' + JSON.stringify(want) + ' entries ' + JSON.stringify(got));
}
const prompts = entries.filter((e) => e.type === 'prompt');
if (prompts.length !== 1) throw new Error('expected 1 prompt entry, got ' + prompts.length);
console.log('entries persist ok: ' + entries.length + ' entries, toolCalls ' + JSON.stringify(want));
" || exit 1

echo "### 10 legacy path still open: unfenced run behaves as today"
RUN_LEGACY="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt again" --base "${BASE}" --json)" || exit 1
printf '%s' "${RUN_LEGACY}" > "${OUT}/run-legacy.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/run-legacy.json', 'utf8'));
if (typeof b.result !== 'string') throw new Error('legacy run must return result');
console.log('legacy run ok');
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
