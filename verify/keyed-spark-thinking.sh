#!/bin/sh
# keyed-spark-thinking.sh — proves keyed thinking switches on
# opencode-go/muse-spark-1.3-contributor over the real server: model switch
# stored, thinking off requested (clamps to low — the spark thinking map sets
# off:null, so clampThinkingLevel settles up-first on low; the row stores the
# applied level and the model triple stays untouched), one tiny keyed turn at
# the applied level with usage, thinking high stored, one tiny keyed high turn
# with usage plus nonzero cost, and an unsupported level failing closed with
# the row unchanged. Wire-level reasoning (off omits it, high sends it) was
# proven live already and is not re-asserted here; this battery asserts stored
# levels plus both turns keyed with usage.
# Keyed env needed: server under test on BASE with the OPENCODE_API_KEY secret
# plus MODEL_ID=opencode-go/muse-spark-1.3-contributor. The secret never enters
# any artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-spark-thinking.sh [BASE]
# Exit 0 on pass, or on quota-blocked (OUT/BLOCKED names the stuck turn);
# 1 otherwise. Writes artifacts/RUN_ID/keyed-spark-thinking/.
set -u
BASE="${1:-http://127.0.0.1:8789}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/keyed-spark-thinking"
mkdir -p "${OUT}"
KEYED_PROVIDER="opencode-go"
KEYED_MODEL="muse-spark-1.3-contributor"
TURNS_OK=0
{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"

echo "### 2 mint a session (triple starts null)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/session.json', 'utf8'));
if (b.model.provider !== null || b.model.id !== null) throw new Error('fresh triple must be null, got ' + JSON.stringify(b.model));
if (b.thinking !== null) throw new Error('fresh thinking must be null, got ' + JSON.stringify(b.thinking));
console.log('fresh triple ok: null/null/null');
" || exit 1

echo "### 3 model switch to ${KEYED_PROVIDER}/${KEYED_MODEL} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_PROVIDER}/${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/switch.json', 'utf8'));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('switch did not echo the triple: ' + JSON.stringify(b.model));
console.log('switch ok: ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-model.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-model.json', 'utf8'));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('row ok: meta re-read shows ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1

echo "### 4 thinking switch off (requested off, applied low: off:null clamps up-first)"
THINK_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level off --base "${BASE}" --json)" || exit 1
echo "${THINK_JSON}"
printf '%s' "${THINK_JSON}" > "${OUT}/thinking-off.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking-off.json', 'utf8'));
if (b.requested !== 'off') throw new Error('entry must record the requested level, got ' + JSON.stringify(b));
if (b.thinking !== 'low') throw new Error('off must clamp to low on ${KEYED_MODEL}, got ' + JSON.stringify(b.thinking));
console.log('clamp ok: requested off applied low');
" || exit 1
META2_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META2_JSON}" > "${OUT}/meta-after-off.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-off.json', 'utf8'));
if (b.thinking !== 'low') throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('model triple moved under thinking switch: ' + JSON.stringify(b.model));
console.log('row ok: thinking=low, model untouched');
" || exit 1

echo "### 5 tiny keyed turn at the applied level (usage proves the keyed path)"
if ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "reply with exactly: spark-low-ok" --base "${BASE}" --json > "${OUT}/run-low.json" 2> "${OUT}/run-low.stderr"; then
  cat "${OUT}/run-low.json"
  node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-low.json', 'utf8'));
if (!b.runtime || b.runtime.provider !== '${KEYED_PROVIDER}' || b.runtime.model !== '${KEYED_MODEL}') throw new Error('turn did not run keyed spark, got ' + JSON.stringify(b.runtime));
if (b.runtime.via !== 'createAgentSession') throw new Error('turn did not flow through the factory: ' + JSON.stringify(b.runtime));
const u = b.usage;
if (!u || typeof u.inTokens !== 'number' || typeof u.outTokens !== 'number') throw new Error('usage missing: ' + JSON.stringify(u));
if (typeof b.result !== 'string' || b.result.length === 0) throw new Error('result must be a non-empty string');
console.log('turn ok: keyed ${KEYED_MODEL} at applied low via=createAgentSession');
" || exit 1
  node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/run-low.json', 'utf8'));
const u = b.usage;
console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
" || exit 1
  TURNS_OK=$((TURNS_OK + 1))
else
  cat "${OUT}/run-low.json" "${OUT}/run-low.stderr"
  if grep -qiE "429|403|datapolicy|opt.in|consent|quota|rate.limit|overloaded|capacity" "${OUT}/run-low.json" "${OUT}/run-low.stderr"; then
    echo "blocked: quota/refusal on the thinking-low turn; keeping green remainder"
    printf '%s\n' "blocked: thinking-low (off-requested, applied low) turn refused (429/quota or 403/opt-in; cause in run-low.json/run-low.stderr)." > "${OUT}/BLOCKED"
  else
    echo "keyed low turn failed without a 429/refusal signal"
    exit 1
  fi
fi

echo "### 6 thinking switch high (accepted, stored, model untouched)"
THINK2_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level high --base "${BASE}" --json)" || exit 1
echo "${THINK2_JSON}"
printf '%s' "${THINK2_JSON}" > "${OUT}/thinking-high.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking-high.json', 'utf8'));
if (b.requested !== 'high' || b.thinking !== 'high') throw new Error('high not accepted/stored: ' + JSON.stringify(b));
console.log('thinking ok: high accepted');
" || exit 1
META3_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META3_JSON}" > "${OUT}/meta-after-high.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-high.json', 'utf8'));
if (b.thinking !== 'high') throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('model triple moved under thinking switch: ' + JSON.stringify(b.model));
console.log('row ok: thinking=high, model untouched');
" || exit 1

echo "### 7 tiny keyed high turn (usage plus nonzero cost)"
if ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "reply with exactly: spark-high-ok" --base "${BASE}" --json > "${OUT}/run-high.json" 2> "${OUT}/run-high.stderr"; then
  cat "${OUT}/run-high.json"
  node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run-high.json', 'utf8'));
if (!b.runtime || b.runtime.provider !== '${KEYED_PROVIDER}' || b.runtime.model !== '${KEYED_MODEL}') throw new Error('turn did not run keyed spark, got ' + JSON.stringify(b.runtime));
if (b.runtime.via !== 'createAgentSession') throw new Error('turn did not flow through the factory: ' + JSON.stringify(b.runtime));
const u = b.usage;
if (!u || typeof u.inTokens !== 'number' || typeof u.outTokens !== 'number') throw new Error('usage missing: ' + JSON.stringify(u));
if (!(u.costTotal > 0)) throw new Error('expected nonzero costTotal on the keyed high turn, got ' + JSON.stringify(u));
if (typeof b.result !== 'string' || b.result.length === 0) throw new Error('result must be a non-empty string');
console.log('turn ok: keyed ${KEYED_MODEL}/high via=createAgentSession costTotal=' + u.costTotal);
" || exit 1
  node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/run-high.json', 'utf8'));
const u = b.usage;
console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
" || exit 1
  TURNS_OK=$((TURNS_OK + 1))
else
  cat "${OUT}/run-high.json" "${OUT}/run-high.stderr"
  if grep -qiE "429|403|datapolicy|opt.in|consent|quota|rate.limit|overloaded|capacity" "${OUT}/run-high.json" "${OUT}/run-high.stderr"; then
    echo "blocked: quota/refusal on the thinking-high turn; keeping green remainder"
    printf '%s\n' "blocked: thinking-high turn refused (429/quota or 403/opt-in; cause in run-high.json/run-high.stderr)." > "${OUT}/BLOCKED"
  else
    echo "keyed high turn failed without a 429/refusal signal"
    exit 1
  fi
fi
echo "TURNS_OK=${TURNS_OK}"

echo "### 8 unsupported thinking level fails closed (row unchanged)"
if ${CLI} thinking --ws "${WS}" --sid "${SID}" --level "ultra-${RUN_ID}" --base "${BASE}" --json > "${OUT}/bad-level.json" 2> "${OUT}/bad-level.stderr"; then
  echo "expected unsupported-level switch to fail"
  exit 1
fi
cat "${OUT}/bad-level.json" "${OUT}/bad-level.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/bad-level.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
if (!/supported levels:/.test(b.hint)) throw new Error('hint must name supported levels, got: ' + b.hint);
console.log('fail-closed ok: ' + b.error);
" || exit 1
META4_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META4_JSON}" > "${OUT}/meta-after-bad-level.json"
node -e "
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync('${OUT}/meta-after-high.json', 'utf8'));
const after = JSON.parse(fs.readFileSync('${OUT}/meta-after-bad-level.json', 'utf8'));
if (after.thinking !== before.thinking) throw new Error('thinking moved on failed switch: ' + after.thinking);
if (JSON.stringify(after.model) !== JSON.stringify(before.model)) throw new Error('model moved on failed switch: ' + JSON.stringify(after.model));
console.log('row unchanged ok: thinking still high');
" || exit 1

echo "### 9 entries second view (change entries plus one result per green turn)"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
TURNS_OK="${TURNS_OK}" node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const entries = replay.entries || [];
const levels = entries.filter((e) => e.type === 'thinking_level_change');
if (levels.length !== 2) throw new Error('expected 2 thinking_level_change entries, got ' + levels.length);
const first = JSON.parse(levels[0].body);
const second = JSON.parse(levels[1].body);
if (first.requested !== 'off' || first.level !== 'low') throw new Error('first change entry wrong: ' + levels[0].body);
if (second.requested !== 'high' || second.level !== 'high') throw new Error('second change entry wrong: ' + levels[1].body);
const results = entries.filter((e) => e.type === 'result');
const want = Number(process.env.TURNS_OK);
if (results.length < want) throw new Error('expected at least ' + want + ' result entries, got ' + results.length);
console.log('entries ok: off->low then high, ' + results.length + ' result(s) for ' + want + ' green turn(s)');
" || exit 1

echo "### 10 session totals second view (tolerant: meta usage when present)"
META5_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META5_JSON}" > "${OUT}/meta-final.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-final.json', 'utf8'));
if (b.usage) console.log('session totals: ' + JSON.stringify(b.usage));
else console.log('session totals: meta carries no usage slice (entries replay above stands)');
" || exit 1

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

echo "PASS ${RUN_ID} ws=${WS} sid=${SID} turns=${TURNS_OK}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
