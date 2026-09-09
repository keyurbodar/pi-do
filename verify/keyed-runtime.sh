#!/bin/sh
# keyed-runtime.sh — proves the key path, no inference.
# With OPENCODE_API_KEY in the caller env (arrives as a Worker secret; the
# server under test must carry it plus MODEL_ID=opencode-go/deepseek-v4-flash):
# buildRuntime goes keyed (stub false, MODEL_ID override resolves with the
# opencode-go baseUrl/api), the models slice shows opencode-go with context
# windows, and a switch to opencode-go/deepseek-v4-flash plus thinking off is
# stored. Turns still run the stub (no network): the seeded read lands in the
# result via createAgentSession. Without the key, the keyed steps are reported
# unreachable and the keyless remainder still passes; the secret never enters
# any artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-runtime.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/keyed-runtime/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/keyed-runtime"
mkdir -p "${OUT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_PROVIDER="opencode-go"
KEYED_MODEL="deepseek-v4-flash"
KEYED_BASEURL="https://opencode.ai/zen/go/v1"
KEYED_API="openai-completions"
{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"

echo "### 2 seed the file the stub reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1

echo "### 3 mint a session (triple starts null)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 triple-less run shows whether the server is keyed"
BASE_LESS_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read ${SEED_PATH}" --base "${BASE}" --json)" || exit 1
printf '%s' "${BASE_LESS_JSON}" > "${OUT}/run-baseless.json"
BASE_LESS_MODEL="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/run-baseless.json', 'utf8')).runtime.model" )"
BASE_LESS_PROVIDER="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/run-baseless.json', 'utf8')).runtime.provider" )"
echo "baseless runtime: ${BASE_LESS_PROVIDER}/${BASE_LESS_MODEL}"
if [ "${BASE_LESS_MODEL}" = "stub" ]; then
  echo "keyed steps unreachable: server runs keyless (no OPENCODE_API_KEY secret); continuing keyless"
  printf '%s\n' "unreachable: buildRuntime stays on the stub without the OPENCODE_API_KEY secret (run-baseless model=stub)." > "${OUT}/keyed-unreachable.txt"
else
  if [ "${BASE_LESS_PROVIDER}" != "${KEYED_PROVIDER}" ] || [ "${BASE_LESS_MODEL}" != "${KEYED_MODEL}" ]; then
    echo "keyed server must resolve MODEL_ID override ${KEYED_PROVIDER}/${KEYED_MODEL}, got ${BASE_LESS_PROVIDER}/${BASE_LESS_MODEL}"
    exit 1
  fi
  echo "keyed ok: stub false path resolves ${KEYED_PROVIDER}/${KEYED_MODEL} via MODEL_ID override"
fi

echo "### 5 keyed resolution values (secret-gated, synthetic value only)"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "keyed values unreachable: OPENCODE_API_KEY absent from caller env; skipping without implying"
  printf '%s\n' "unreachable: OPENCODE_API_KEY absent from caller env; baseUrl/api values not probed." >> "${OUT}/keyed-unreachable.txt"
else
  cat > "${OUT}/probe.mjs" <<EOF
// Probe runs against the repo tree with a synthetic non-empty value: Worker
// secrets never leave the host env, and buildRuntime branches on non-empty,
// so this proves the resolution shape without moving key material.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const { buildRuntime } = await import(pathToFileURL(root + "/worker/src/model-runtime.ts").href);
const keyed = buildRuntime({ OPENCODE_API_KEY: "keyed-proof-probe", MODEL_ID: "${KEYED_PROVIDER}/${KEYED_MODEL}" });
const fail = (msg) => { console.error("probe: " + msg); process.exit(1); };
if (keyed.stub !== false) fail("stub must be false, got " + keyed.stub);
if (keyed.model.provider !== "${KEYED_PROVIDER}") fail("provider, got " + keyed.model.provider);
if (keyed.model.id !== "${KEYED_MODEL}") fail("id, got " + keyed.model.id);
if (keyed.model.baseUrl !== "${KEYED_BASEURL}") fail("baseUrl, got " + keyed.model.baseUrl);
if (keyed.model.api !== "${KEYED_API}") fail("api, got " + keyed.model.api);
const keyless = buildRuntime({});
if (keyless.stub !== true) fail("keyless must stay stub");
writeFileSync(process.argv[3], JSON.stringify({ stub: keyed.stub, provider: keyed.model.provider, id: keyed.model.id, baseUrl: keyed.model.baseUrl, api: keyed.model.api }) + "\n");
console.log("probe ok: keyed resolves ${KEYED_PROVIDER}/${KEYED_MODEL} ${KEYED_API} ${KEYED_BASEURL}, keyless stays stub");
EOF
  node "${OUT}/probe.mjs" "${ROOT}" "${OUT}/keyed-resolution.json" || exit 1
  cat "${OUT}/keyed-resolution.json"
fi

echo "### 6 models slice shows ${KEYED_PROVIDER} with context windows"
MODELS_JSON="$(${CLI} models --provider "${KEYED_PROVIDER}" --base "${BASE}" --json)" || exit 1
printf '%s' "${MODELS_JSON}" > "${OUT}/models-slice.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/models-slice.json', 'utf8'));
const hit = (b.models || []).find((m) => m.provider === '${KEYED_PROVIDER}' && m.id === '${KEYED_MODEL}');
if (!hit) throw new Error('${KEYED_PROVIDER}/${KEYED_MODEL} missing from slice');
if (typeof hit.contextWindow !== 'number' || hit.contextWindow <= 0) throw new Error('contextWindow missing: ' + JSON.stringify(hit));
console.log('slice ok: ${KEYED_PROVIDER}/${KEYED_MODEL} ctx ' + hit.contextWindow);
" || exit 1

echo "### 7 model switch to ${KEYED_PROVIDER}/${KEYED_MODEL} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_PROVIDER}/${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-switch.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-after-switch.json', 'utf8'));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('stored ok: meta re-read shows ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1

echo "### 8 thinking switch to off (accepted, stored, model untouched)"
THINK_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level off --base "${BASE}" --json)" || exit 1
echo "${THINK_JSON}"
printf '%s' "${THINK_JSON}" > "${OUT}/thinking.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking.json', 'utf8'));
if (b.requested !== 'off' || b.thinking !== 'off') throw new Error('off not accepted/stored: ' + JSON.stringify(b));
console.log('thinking ok: off accepted');
" || exit 1
META2_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META2_JSON}" > "${OUT}/meta-after-thinking.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
if (b.thinking !== 'off') throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('model triple moved: ' + JSON.stringify(b.model));
console.log('row ok: thinking=off, model untouched');
" || exit 1

echo "### 9 turn runs the stub (seeded read in result, entries second view)"
SEED_BODY="${SEED_BODY}" RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read ${SEED_PATH}" --base "${BASE}" --json)" || exit 1
echo "${RUN_JSON}"
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
SEED_BODY="${SEED_BODY}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
if (b.runtime.model !== '${KEYED_MODEL}') throw new Error('turn did not record the switched model: ' + JSON.stringify(b.runtime));
if (b.runtime.provider !== '${KEYED_PROVIDER}') throw new Error('turn did not record the provider: ' + JSON.stringify(b.runtime));
if (b.runtime.via !== 'createAgentSession') throw new Error('turn did not run the stub session: ' + JSON.stringify(b.runtime));
if (!b.result.includes(process.env.SEED_BODY)) throw new Error('stub result missing seeded read output');
console.log('stub ok: ${KEYED_MODEL} recorded, seeded read returned, no network turn');
" || exit 1
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
SEED_BODY="${SEED_BODY}" node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const results = (replay.entries || []).filter((e) => e.type === 'result');
if (results.length < 1) throw new Error('no result entries persisted');
if (!results.some((e) => e.body.includes(process.env.SEED_BODY))) throw new Error('persisted results miss the seeded read');
console.log('entries ok: ' + results.length + ' result(s), seeded read persisted');
" || exit 1

echo "### 9b usage timing split (sqlMs/inferenceMs/frameMs integers on the turn payload)"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/run.json', 'utf8'));
const u = b.usage;
if (!u || typeof u !== 'object') throw new Error('run.json missing usage payload');
for (const k of ['sqlMs', 'inferenceMs', 'frameMs']) {
  if (typeof u[k] !== 'number' || !Number.isInteger(u[k]) || u[k] < 0) throw new Error('usage.' + k + ' must be an integer >= 0: ' + JSON.stringify(u));
}
console.log('timing split: sqlMs=' + u.sqlMs + ' inferenceMs=' + u.inferenceMs + ' frameMs=' + u.frameMs + ' elapsedMs=' + u.elapsedMs);
" || exit 1

echo "### 10 redaction grep over the artifacts"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "redaction vacuous keyless: no secret in caller env, nothing could have leaked"
  printf '%s\n' "redaction: vacuous (no OPENCODE_API_KEY in caller env)." > "${OUT}/redaction.txt"
else
  prefix="$(printf '%s' "${OPENCODE_API_KEY}" | cut -c1-16)"
  if grep -rF -q -- "${prefix}" "${OUT}"; then
    echo "key material leaked into ${OUT}"
    exit 1
  fi
  if grep -rF -q -- "keyed-proof-probe" "${OUT}/keyed-resolution.json" "${OUT}/run-baseless.json" "${OUT}/run.json" 2>/dev/null; then
    echo "probe value leaked into resolution artifacts"
    exit 1
  fi
  echo "redaction ok: key prefix absent from ${OUT}"
  printf '%s\n' "redaction: key prefix absent from ${OUT} (grep exit 1, no match)." > "${OUT}/redaction.txt"
fi

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
