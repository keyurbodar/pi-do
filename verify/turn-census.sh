#!/bin/sh
# turn-census.sh — runs one keyed turn and prints the write census: SQL ops
# count (entry appends, one INSERT each), rows written, bytes per entry, and
# writes-per-turn, plus the usage timing split. The turn must be real keyed
# inference (usage inTokens>0 and costTotal>0 prove it).
# A refused run path exits 2 BLOCKED (never PASS); a stub-path turn exits 2
# BLOCKED missing-secret (the stub turn touches no provider inference).
# Usage: sh verify/turn-census.sh [BASE]
# Exit 0 on pass, 2 on blocked (OUT/BLOCKED names the cause), 1 otherwise.
set -u
BASE="${1:-http://127.0.0.1:8791}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/turn-census"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_MODEL="opencode-go/deepseek-v4-flash"
TINY_PROMPT="read ${SEED_PATH}, then answer in under ten words: what did it say?"
{
echo "### 0 key presence by length only (proves against an isolated keyed BASE, never the house 8787)"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
echo "caller env carries no OPENCODE_API_KEY"
else
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"
echo "### 2 seed a tiny file the keyed turn reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"
echo "### 4 switch to ${KEYED_MODEL} plus thinking off (cheap, still keyed)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
${CLI} thinking --ws "${WS}" --sid "${SID}" --level off --base "${BASE}" --json || exit 1
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-switch.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (b.model.provider !== 'opencode-go' || b.model.id !== 'deepseek-v4-flash') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows opencode-go/deepseek-v4-flash');
" || exit 1
echo "### 5 entries before the turn"
BEFORE_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${BEFORE_JSON}" > "${OUT}/entries-before.json"
BEFORE_COUNT="$(node -p "JSON.parse(process.argv[1]).entries.length" "${BEFORE_JSON}")"
echo "entries before=${BEFORE_COUNT}"
echo "### 6 run one keyed turn (wall clock timed)"
T0="$(date +%s)"
RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${TINY_PROMPT}" --base "${BASE}" --json)" || exit 1
T1="$(date +%s)"
WALL_S="$((T1 - T0))"
echo "wall time ${WALL_S}s"
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
echo "${RUN_JSON}"
echo "wall_s=${WALL_S}" > "${OUT}/wall.txt"
echo "### 6b block guard: 429/quota or provider refusal is reported, not failed"
if node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
const blob = JSON.stringify(b);
if (/error[^}]{0,300}?(429|403|quota|rate.?limit|datapolicy|opt.in|consent|exceeded|insufficient)/i.test(blob)) { console.log('blocked: run path refused'); process.exit(0); }
process.exit(1);
"; then
  printf '%s\n' "BLOCKED: turn-census refused on the run path (429/quota or 403/opt-in; census unproven this run; cause in run.json)." > "${OUT}/BLOCKED"
  echo "BLOCKED run path refused; transcript kept, exiting 2"
  exit 2
fi
echo "### 7 real-inference gate: stub turns read BLOCKED, keyed usage gaps fail"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
if (!b.runtime || b.runtime.provider !== 'opencode-go' || b.runtime.stub === true) {
  fs.writeFileSync('${OUT}/BLOCKED', 'blocked: turn-census missing-secret plumbing (turn ran the stub path; server key absent; cause in run.json).\n');
  console.log('BLOCKED missing secret: turn ran stub, census unproven; exiting 2');
  process.exit(2);
}
const u = b.usage;
if (!u || typeof u !== 'object') throw new Error('run.json missing usage payload');
if (!(u.inTokens > 0)) throw new Error('keyed turn with no input tokens: ' + JSON.stringify(u));
if (!(u.costTotal > 0)) throw new Error('keyed turn with no cost: ' + JSON.stringify(u));
for (const k of ['sqlMs', 'inferenceMs', 'frameMs']) {
  if (typeof u[k] !== 'number' || !Number.isInteger(u[k]) || u[k] < 0) throw new Error('usage.' + k + ' must be an integer >= 0: ' + JSON.stringify(u));
}
console.log('keyed ok: provider=opencode-go in=' + u.inTokens + ' out=' + u.outTokens + ' costTotal=' + u.costTotal);
console.log('timing split: sqlMs=' + u.sqlMs + ' inferenceMs=' + u.inferenceMs + ' frameMs=' + u.frameMs + ' elapsedMs=' + u.elapsedMs);
" || { code=$?; if [ "${code}" = "2" ]; then exit 2; fi; exit 1; }
echo "### 8 entries after the turn plus the census table"
AFTER_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${AFTER_JSON}" > "${OUT}/entries-after.json"
BEFORE_COUNT="${BEFORE_COUNT}" node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries-after.json', 'utf8'));
const before = Number(process.env.BEFORE_COUNT);
const fresh = replay.entries.slice(before);
if (fresh.length === 0) throw new Error('turn wrote no entry rows');
console.log('cursor | type | bytes');
for (const e of fresh) {
  const bytes = Buffer.byteLength(typeof e.body === 'string' ? e.body : JSON.stringify(e.body), 'utf8');
  console.log(e.cursor + ' | ' + e.type + ' | ' + bytes);
}
const total = fresh.reduce((n, e) => n + Buffer.byteLength(typeof e.body === 'string' ? e.body : JSON.stringify(e.body), 'utf8'), 0);
console.log('census: sql_appends=' + fresh.length + ' rows_written=' + fresh.length + ' total_bytes=' + total + ' writes_per_turn=' + fresh.length);
" || exit 1
echo "### 9 redaction grep over the artifacts"
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
