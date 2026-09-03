#!/bin/sh
# model-switch.sh — proves mid-session model plus thinking switches: mint a
# session, switch model clean (entry appended, /run reports the new model),
# switch thinking (entry, clamped), send unknown id (fail closed, row
# unchanged), send unsupported level (fail closed), run a one-shot override
# (turn uses it, row unchanged), and replay entries showing both change
# entries in cursor order. Keyless: the stub ignores the model and records it.
# Usage: sh verify/model-switch.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/model-switch/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/model-switch"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
MODEL_PROVIDER="anthropic"
MODEL_ID="claude-opus-4-6"
ALT_ID="claude-sonnet-4-5"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the stub reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1

echo "### 3 mint a session (triple starts null)"
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

echo "### 4 models catalog lists provider ids with context windows"
MODELS_JSON="$(${CLI} models --provider "${MODEL_PROVIDER}" --base "${BASE}" --json)" || exit 1
printf '%s' "${MODELS_JSON}" > "${OUT}/models.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/models.json', 'utf8'));
const hit = (b.models || []).find((m) => m.provider === '${MODEL_PROVIDER}' && m.id === '${MODEL_ID}');
if (!hit) throw new Error('${MODEL_PROVIDER}/${MODEL_ID} missing from catalog');
if (typeof hit.contextWindow !== 'number' || hit.contextWindow <= 0) throw new Error('contextWindow missing on ' + JSON.stringify(hit));
console.log('catalog ok: ${MODEL_PROVIDER}/${MODEL_ID} ctx ' + hit.contextWindow);
" || exit 1

echo "### 5 clean model switch (entry appended, row updated)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${MODEL_PROVIDER}/${MODEL_ID}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/switch.json', 'utf8'));
if (b.model.provider !== '${MODEL_PROVIDER}' || b.model.id !== '${MODEL_ID}') throw new Error('switch did not echo the triple: ' + JSON.stringify(b.model));
console.log('switch ok: ' + b.model.provider + '/' + b.model.id);
" || exit 1
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-model.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-model.json', 'utf8'));
if (b.model.provider !== '${MODEL_PROVIDER}' || b.model.id !== '${MODEL_ID}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('row ok: meta re-read shows ${MODEL_PROVIDER}/${MODEL_ID}');
" || exit 1

echo "### 6 /run reports the new model (keyless stub records it)"
RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json)" || exit 1
echo "${RUN_JSON}"
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
SEED_BODY="${SEED_BODY}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
if (b.runtime.model !== '${MODEL_ID}') throw new Error('run did not report the switched model, got ' + JSON.stringify(b.runtime));
if (b.runtime.provider !== '${MODEL_PROVIDER}') throw new Error('run did not report the provider, got ' + JSON.stringify(b.runtime));
if (!b.result.includes(process.env.SEED_BODY)) throw new Error('stub result missing seeded read output');
console.log('run ok: model=${MODEL_ID} via=' + b.runtime.via);
" || exit 1

echo "### 7 thinking switch clamps (xhigh unsupported on ${MODEL_ID} -> max)"
THINK_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level xhigh --base "${BASE}" --json)" || exit 1
echo "${THINK_JSON}"
printf '%s' "${THINK_JSON}" > "${OUT}/thinking.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking.json', 'utf8'));
if (b.requested !== 'xhigh') throw new Error('entry must record the requested level, got ' + JSON.stringify(b));
if (b.thinking !== 'max') throw new Error('xhigh must clamp to max on ${MODEL_ID}, got ' + JSON.stringify(b.thinking));
console.log('clamp ok: requested xhigh applied max');
" || exit 1
META2_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META2_JSON}" > "${OUT}/meta-after-thinking.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
if (b.thinking !== 'max') throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
if (b.model.id !== '${MODEL_ID}') throw new Error('model triple moved under thinking switch: ' + JSON.stringify(b.model));
console.log('row ok: thinking=max, model untouched');
" || exit 1

echo "### 8 unknown model id fails closed (row plus entries unchanged)"
ENTRIES_BEFORE="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_BEFORE}" > "${OUT}/entries-before-fail.json"
if ${CLI} model --ws "${WS}" --sid "${SID}" --model "nope-${RUN_ID}/nope" --base "${BASE}" --json > "${OUT}/bad-model.json" 2> "${OUT}/bad-model.stderr"; then
  echo "expected unknown-id switch to fail"
  exit 1
fi
cat "${OUT}/bad-model.json" "${OUT}/bad-model.stderr"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/bad-model.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('fail-closed ok: ' + b.error);
" || exit 1
META3_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META3_JSON}" > "${OUT}/meta-after-bad-model.json"
node -e "
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
const after = JSON.parse(fs.readFileSync('${OUT}/meta-after-bad-model.json', 'utf8'));
if (JSON.stringify(after.model) !== JSON.stringify(before.model) || after.thinking !== before.thinking) {
  throw new Error('row moved on failed switch: ' + JSON.stringify(after.model) + '/' + after.thinking);
}
console.log('row unchanged ok: still ${MODEL_PROVIDER}/${MODEL_ID}/max');
" || exit 1
ENTRIES_AFTER="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_AFTER}" > "${OUT}/entries-after-bad-model.json"
node -e "
const fs = require('node:fs');
const a = JSON.parse(fs.readFileSync('${OUT}/entries-before-fail.json', 'utf8'));
const b = JSON.parse(fs.readFileSync('${OUT}/entries-after-bad-model.json', 'utf8'));
if (a.count !== b.count || a.head !== b.head) throw new Error('entries moved on failed switch: ' + a.count + ' -> ' + b.count);
console.log('entries unchanged ok: count ' + b.count);
" || exit 1

echo "### 9 unsupported thinking level fails closed"
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
const before = JSON.parse(fs.readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
const after = JSON.parse(fs.readFileSync('${OUT}/meta-after-bad-level.json', 'utf8'));
if (after.thinking !== before.thinking) throw new Error('thinking moved on failed switch: ' + after.thinking);
console.log('row unchanged ok: thinking still max');
" || exit 1

echo "### 10 stale fence on a switch is 403 with no mutation"
if ${CLI} model --ws "${WS}" --sid "${SID}" --model "${MODEL_PROVIDER}/${ALT_ID}" --fence "dead-${RUN_ID}" --expected 0 --base "${BASE}" --json > "${OUT}/bad-fence.json" 2> "${OUT}/bad-fence.stderr"; then
  echo "expected stale-fence switch to fail"
  exit 1
fi
cat "${OUT}/bad-fence.json" "${OUT}/bad-fence.stderr"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/bad-fence.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
if (!/Fenced/.test(b.hint)) throw new Error('403 hint must say Fenced, got: ' + b.hint);
console.log('403 Fenced ok');
" || exit 1
META5_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META5_JSON}" > "${OUT}/meta-after-bad-fence.json"
node -e "
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
const after = JSON.parse(fs.readFileSync('${OUT}/meta-after-bad-fence.json', 'utf8'));
if (JSON.stringify(after.model) !== JSON.stringify(before.model)) throw new Error('row moved on 403: ' + JSON.stringify(after.model));
console.log('row unchanged ok after 403');
" || exit 1

echo "### 11 one-shot override (turn uses it, row unchanged)"
ONE_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --model "${MODEL_PROVIDER}/${ALT_ID}" --thinking high --base "${BASE}" --json)" || exit 1
echo "${ONE_JSON}"
printf '%s' "${ONE_JSON}" > "${OUT}/oneshot.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/oneshot.json', 'utf8'));
if (b.runtime.model !== '${ALT_ID}') throw new Error('one-shot turn did not use the override, got ' + JSON.stringify(b.runtime));
if (b.runtime.thinking !== 'high') throw new Error('one-shot thinking not applied, got ' + JSON.stringify(b.runtime));
console.log('one-shot ok: turn ran ${ALT_ID}/high');
" || exit 1
META6_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META6_JSON}" > "${OUT}/meta-after-oneshot.json"
node -e "
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
const after = JSON.parse(fs.readFileSync('${OUT}/meta-after-oneshot.json', 'utf8'));
if (JSON.stringify(after.model) !== JSON.stringify(before.model) || after.thinking !== before.thinking) {
  throw new Error('one-shot persisted: ' + JSON.stringify(after.model) + '/' + after.thinking);
}
console.log('row unchanged ok: one-shot persisted nothing');
" || exit 1

echo "### 12 replay shows both change entries in cursor order"
FULL_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${FULL_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const entries = replay.entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
const models = entries.filter((e) => e.type === 'model_change');
const levels = entries.filter((e) => e.type === 'thinking_level_change');
if (models.length !== 1) throw new Error('expected 1 model_change, got ' + models.length);
if (levels.length !== 1) throw new Error('expected 1 thinking_level_change, got ' + levels.length);
const m = JSON.parse(models[0].body);
if (m.to.provider !== '${MODEL_PROVIDER}' || m.to.id !== '${MODEL_ID}') throw new Error('model_change body wrong: ' + models[0].body);
const t = JSON.parse(levels[0].body);
if (t.requested !== 'xhigh' || t.level !== 'max') throw new Error('thinking entry body wrong: ' + levels[0].body);
if (!(models[0].cursor < levels[0].cursor)) throw new Error('change entries out of order');
console.log('replay ok: ' + entries.length + ' entries, model_change@' + models[0].cursor + ' thinking_level_change@' + levels[0].cursor);
" || exit 1

echo "### 13 workspace defaults apply at session mint"
SET_JSON="$(${CLI} settings --ws "${WS}" --model "${MODEL_PROVIDER}/${ALT_ID}" --level low --base "${BASE}" --json)" || exit 1
echo "${SET_JSON}"
SESS2_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS2_JSON}"
printf '%s' "${SESS2_JSON}" > "${OUT}/session2.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/session2.json', 'utf8'));
if (b.model.provider !== '${MODEL_PROVIDER}' || b.model.id !== '${ALT_ID}') throw new Error('mint missed default model: ' + JSON.stringify(b.model));
if (b.thinking !== 'low') throw new Error('mint missed default thinking: ' + JSON.stringify(b.thinking));
console.log('defaults ok: fresh session minted ${MODEL_PROVIDER}/${ALT_ID}/low');
" || exit 1
if ${CLI} settings --ws "${WS}" --model "nope-${RUN_ID}/nope" --base "${BASE}" --json > "${OUT}/bad-settings.json" 2> "${OUT}/bad-settings.stderr"; then
  echo "expected unknown-id settings to fail"
  exit 1
fi
cat "${OUT}/bad-settings.json" "${OUT}/bad-settings.stderr"
GET_JSON="$(${CLI} settings --ws "${WS}" --base "${BASE}" --json)" || exit 1
printf '%s' "${GET_JSON}" > "${OUT}/settings.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/settings.json', 'utf8'));
if (b.settings.modelId !== '${ALT_ID}') throw new Error('settings moved on failed patch: ' + JSON.stringify(b.settings));
console.log('settings fail-closed ok: still ${MODEL_PROVIDER}/${ALT_ID}');
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
