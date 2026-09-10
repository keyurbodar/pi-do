#!/bin/sh
# cli-proof.sh — end-to-end proof that the pi-do CLI covers every command:
# mint a fresh workspace+session (keyless), seed seed.txt, then exercise
# doctor, workspace/session create, files put/get/ls/rm, exec, git status,
# run, claim fence rotation, model/thinking switches, models catalog,
# settings put/get, gapless entries paging (limit=3 byte-equals full replay),
# meta cursor, one live stream turn over the CLI, and a model round-trip.
# Usage: sh verify/cli-proof.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/cli-proof/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/cli-proof"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
MARKER="cli-proof-marker-${RUN_ID}"
STUB_MARKER="harness-bash-ok"
MODEL_PROVIDER="anthropic"
MODEL_ID="claude-opus-4-6"
ALT_ID="claude-sonnet-4-5"

{
echo "### 1 doctor sees the worker"
${CLI} doctor --base "${BASE}" --json || exit 1

echo "### 2 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
test -n "${WS}" || { echo "FAIL: empty workspace id"; exit 1; }

echo "### 3 session create (fence F0, revision 0)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"
test -n "${SID}" || { echo "FAIL: empty session id"; exit 1; }

echo "### 4 files put/get/ls/rm"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1
printf 'scratch' | ${CLI} files put --ws "${WS}" --path "scratch.txt" --base "${BASE}" --json || exit 1
${CLI} files get --ws "${WS}" --path "seed.txt" --base "${BASE}" --out "${OUT}/got.bin" || exit 1
printf '%s' "${SEED_BODY}" > "${OUT}/want.bin"
cmp "${OUT}/want.bin" "${OUT}/got.bin" || exit 1
echo "get byte-identical ok"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
echo "${LS_JSON}"
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/ls.json', 'utf8'));
const paths = (b.entries || []).map((e) => e.path);
for (const want of ['seed.txt', 'scratch.txt']) {
  if (!paths.includes(want)) throw new Error('ls missing ' + want + ': ' + JSON.stringify(paths));
}
console.log('ls ok: seed.txt + scratch.txt present');
" || exit 1
${CLI} files rm --ws "${WS}" --path "scratch.txt" --base "${BASE}" --json || exit 1
if ${CLI} files get --ws "${WS}" --path "scratch.txt" --base "${BASE}" --out "${OUT}/gone.bin" --json > "${OUT}/gone.json" 2> "${OUT}/gone.stderr"; then
  echo "expected get-after-rm to fail"; exit 1
fi
cat "${OUT}/gone.json" "${OUT}/gone.stderr"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/gone.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('get-after-rm 404 hint ok: ' + b.error);
" || exit 1
LS2_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
printf '%s' "${LS2_JSON}" > "${OUT}/ls2.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/ls2.json', 'utf8'));
const paths = (b.entries || []).map((e) => e.path);
if (paths.includes('scratch.txt')) throw new Error('rm did not stick: ' + JSON.stringify(paths));
if (!paths.includes('seed.txt')) throw new Error('rm took seed.txt too: ' + JSON.stringify(paths));
console.log('rm ok: scratch.txt gone, seed.txt kept');
" || exit 1

echo "### 5 exec echo (stdout must carry the marker, exit 0)"
EXEC_JSON="$(${CLI} exec --ws "${WS}" --command "echo ${MARKER}" --base "${BASE}" --json)" || exit 1
echo "${EXEC_JSON}"
printf '%s' "${EXEC_JSON}" > "${OUT}/exec.json"
MARKER="${MARKER}" node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/exec.json', 'utf8'));
if (b.exit !== 0) throw new Error('expected exit 0, got ' + b.exit);
if (!String(b.stdout).includes(process.env.MARKER)) throw new Error('stdout missing marker');
console.log('exec ok: stdout carries marker, exit 0');
" || exit 1

echo "### 6 git status on the empty workspace is structured not-a-repo"
if ${CLI} git --ws "${WS}" --sid "${SID}" --base "${BASE}" --json status > "${OUT}/git.json" 2> "${OUT}/git.stderr"; then
  echo "expected git status on a repo-less workspace to fail"; exit 1
fi
cat "${OUT}/git.json" "${OUT}/git.stderr"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/git.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('git 404 hint ok: ' + b.error);
" || exit 1
grep -q "not a git repository" "${OUT}/git.json" || { echo "FAIL: git body must say not a git repository"; exit 1; }
echo "git not-a-repo ok"

echo "### 7 claim rotates the fence (F0, 0 -> F1, 1)"
CLAIM_JSON="$(${CLI} claim --ws "${WS}" --sid "${SID}" --fence "${F0}" --expected "${R0}" --base "${BASE}" --json)" || exit 1
echo "${CLAIM_JSON}"
printf '%s' "${CLAIM_JSON}" > "${OUT}/claim.json"
F1="$(node -p "JSON.parse(process.argv[1]).fence" "${CLAIM_JSON}")"
R1="$(node -p "JSON.parse(process.argv[1]).revision" "${CLAIM_JSON}")"
echo "F1=${F1} R1=${R1}"
F0="${F0}" F1="${F1}" R1="${R1}" R0="${R0}" node -e "
if (!process.env.F1 || process.env.F1 === process.env.F0) throw new Error('fence must rotate on claim');
if (Number(process.env.R1) !== Number(process.env.R0) + 1) throw new Error('revision must bump, got ' + process.env.R1);
console.log('claim ok: fence rotated, revision ' + process.env.R0 + '->' + process.env.R1);
" || exit 1

echo "### 8 run one headless turn (seeded read output plus bash marker)"
RUN_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json)" || exit 1
echo "${RUN_JSON}"
printf '%s' "${RUN_JSON}" > "${OUT}/run.json"
SEED_BODY="${SEED_BODY}" STUB_MARKER="${STUB_MARKER}" node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/run.json', 'utf8'));
if (typeof b.result !== 'string') throw new Error('result must be a string');
if (!b.result.includes(process.env.SEED_BODY)) throw new Error('result missing seeded read output');
if (!b.result.includes(process.env.STUB_MARKER)) throw new Error('result missing bash marker');
const names = (b.toolCalls || []).map((c) => c.tool).sort().join(',');
if (names !== 'bash,read') throw new Error('expected read+bash toolCalls, got ' + names);
console.log('run ok: read output + bash marker, 2 tool calls');
" || exit 1

echo "### 9 model switch to ${MODEL_PROVIDER}/${MODEL_ID} (row follows)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${MODEL_PROVIDER}/${MODEL_ID}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/switch.json', 'utf8'));
if (b.model.provider !== '${MODEL_PROVIDER}' || b.model.id !== '${MODEL_ID}') throw new Error('switch did not echo the triple: ' + JSON.stringify(b.model));
console.log('switch ok: ${MODEL_PROVIDER}/${MODEL_ID}');
" || exit 1
META_MODEL="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_MODEL}" > "${OUT}/meta-after-model.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-model.json', 'utf8'));
if (b.model.provider !== '${MODEL_PROVIDER}' || b.model.id !== '${MODEL_ID}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('row ok: meta re-read shows ${MODEL_PROVIDER}/${MODEL_ID}');
" || exit 1

echo "### 10 thinking switch to max (row follows)"
THINK_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level max --base "${BASE}" --json)" || exit 1
echo "${THINK_JSON}"
printf '%s' "${THINK_JSON}" > "${OUT}/thinking.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking.json', 'utf8'));
if (b.thinking !== 'max') throw new Error('expected applied max, got ' + JSON.stringify(b.thinking));
console.log('thinking ok: max');
" || exit 1
META_THINK="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_THINK}" > "${OUT}/meta-after-thinking.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-thinking.json', 'utf8'));
if (b.thinking !== 'max') throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
if (b.model.id !== '${MODEL_ID}') throw new Error('model triple moved under thinking switch: ' + JSON.stringify(b.model));
console.log('row ok: thinking=max, model untouched');
" || exit 1

echo "### 11 models catalog lists ${MODEL_PROVIDER}/${MODEL_ID}"
MODELS_JSON="$(${CLI} models --provider "${MODEL_PROVIDER}" --base "${BASE}" --json)" || exit 1
printf '%s' "${MODELS_JSON}" > "${OUT}/models.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/models.json', 'utf8'));
const hit = (b.models || []).find((m) => m.provider === '${MODEL_PROVIDER}' && m.id === '${MODEL_ID}');
if (!hit) throw new Error('${MODEL_PROVIDER}/${MODEL_ID} missing from catalog');
if (typeof hit.contextWindow !== 'number' || hit.contextWindow <= 0) throw new Error('contextWindow missing on ' + JSON.stringify(hit));
console.log('catalog ok: ${MODEL_PROVIDER}/${MODEL_ID} ctx ' + hit.contextWindow);
" || exit 1

echo "### 12 settings put+get, fresh session mints the defaults"
${CLI} settings --ws "${WS}" --model "${MODEL_PROVIDER}/${ALT_ID}" --level low --base "${BASE}" --json || exit 1
GET_JSON="$(${CLI} settings --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${GET_JSON}"
printf '%s' "${GET_JSON}" > "${OUT}/settings.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/settings.json', 'utf8'));
if (b.settings.modelId !== '${ALT_ID}') throw new Error('settings modelId wrong: ' + JSON.stringify(b.settings));
console.log('settings ok: defaults stored for ${MODEL_PROVIDER}/${ALT_ID}');
" || exit 1
SESS2_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS2_JSON}"
printf '%s' "${SESS2_JSON}" > "${OUT}/session2.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/session2.json', 'utf8'));
if (b.model.provider !== '${MODEL_PROVIDER}' || b.model.id !== '${ALT_ID}') throw new Error('mint missed default model: ' + JSON.stringify(b.model));
if (b.thinking !== 'low') throw new Error('mint missed default thinking: ' + JSON.stringify(b.thinking));
console.log('defaults ok: fresh session minted ${MODEL_PROVIDER}/${ALT_ID}/low');
" || exit 1

echo "### 13 model round-trip: run on the switched session reports ${MODEL_ID}"
ROUND_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json)" || exit 1
echo "${ROUND_JSON}"
printf '%s' "${ROUND_JSON}" > "${OUT}/round.json"
SEED_BODY="${SEED_BODY}" node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/round.json', 'utf8'));
if (b.runtime.model !== '${MODEL_ID}') throw new Error('run did not report the switched model, got ' + JSON.stringify(b.runtime));
if (b.runtime.provider !== '${MODEL_PROVIDER}') throw new Error('run did not report the provider, got ' + JSON.stringify(b.runtime));
if (!b.result.includes(process.env.SEED_BODY)) throw new Error('round-trip result missing seeded read output');
console.log('round-trip ok: run reports ${MODEL_ID} via=' + b.runtime.via);
" || exit 1

echo "### 14 entries full replay plus limit=3 paging (byte-equals, gapless)"
FULL_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${FULL_JSON}" > "${OUT}/full.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/full.json', 'utf8'));
if (!Array.isArray(b.entries) || b.entries.length === 0) throw new Error('full replay must be non-empty');
if (typeof b.head !== 'number' || typeof b.count !== 'number') throw new Error('entries must carry { head, count }');
if (b.count !== b.entries.length) throw new Error('count must equal replay length');
console.log('full replay ok: ' + b.entries.length + ' entries head=' + b.head);
" || exit 1
AFTER=0
N=0
while true; do
  PAGE_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after "${AFTER}" --limit 3 --base "${BASE}" --json)" || exit 1
  printf '%s' "${PAGE_JSON}" > "${OUT}/page-${N}.json"
  echo "page ${N} after=${AFTER}: ${PAGE_JSON}"
  GOT="$(node -p "JSON.parse(process.argv[1]).entries.length" "${PAGE_JSON}")"
  if [ "${GOT}" -eq 0 ]; then break; fi
  if [ "${GOT}" -gt 3 ]; then echo "page larger than limit"; exit 1; fi
  AFTER="$(node -p "JSON.parse(process.argv[1]).entries.at(-1).cursor" "${PAGE_JSON}")"
  N=$((N + 1))
  if [ "${N}" -gt 100 ]; then echo "paging did not terminate"; exit 1; fi
done
export PAGES="${N}"
echo "PAGES=${N}"
node -e "
const fs = require('node:fs');
const path = require('node:path');
const pages = Number(process.env.PAGES);
const full = JSON.parse(fs.readFileSync('${OUT}/full.json', 'utf8')).entries;
const paged = [];
for (let i = 0; i < pages; i++) {
  paged.push(...JSON.parse(fs.readFileSync(path.join('${OUT}', 'page-' + i + '.json'), 'utf8')).entries);
}
if (JSON.stringify(paged) !== JSON.stringify(full)) throw new Error('paged replay differs from full replay');
const cursors = paged.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
console.log('paged replay byte-equals full replay: ' + paged.length + ' entries in cursor order, no gaps');
" || exit 1
ALL_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --all --base "${BASE}" --json)" || exit 1
printf '%s' "${ALL_JSON}" > "${OUT}/all.json"
node -e "
const fs = require('node:fs');
const full = JSON.parse(fs.readFileSync('${OUT}/full.json', 'utf8')).entries;
const all = JSON.parse(fs.readFileSync('${OUT}/all.json', 'utf8')).entries;
if (JSON.stringify(all) !== JSON.stringify(full)) throw new Error('--all replay differs from full replay');
console.log('--all ok: gapless replay matches full (' + all.length + ' entries)');
" || exit 1

echo "### 15 meta head equals the last cursor"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
echo "${META_JSON}"
printf '%s' "${META_JSON}" > "${OUT}/meta.json"
WS="${WS}" SID="${SID}" node -e "
const m = JSON.parse(require('node:fs').readFileSync('${OUT}/meta.json', 'utf8'));
const full = JSON.parse(require('node:fs').readFileSync('${OUT}/full.json', 'utf8'));
const last = full.entries.at(-1).cursor;
if (m.sid !== process.env.SID) throw new Error('meta sid mismatch');
if (m.ws !== process.env.WS) throw new Error('meta ws mismatch');
if (m.head !== last) throw new Error('meta head ' + m.head + ' must equal last cursor ' + last);
if (m.count !== full.entries.length) throw new Error('meta count must equal replay length');
if (full.head !== m.head || full.count !== m.count) throw new Error('entries head/count must match meta');
console.log('meta ok: head=' + m.head + ' count=' + m.count + ' openRun=null');
" || exit 1

echo "### 16 stream one live turn over the CLI (piped prompt, entry+done)"
printf 'read seed.txt\n' | ${CLI} stream --ws "${WS}" --sid "${SID}" --base "${BASE}" > "${OUT}/stream.out" 2> "${OUT}/stream.stderr" &
STREAM_PID=$!
N=0
STREAM_PREMATURE=0
while [ "${N}" -lt 30 ]; do
  if grep -q "^done" "${OUT}/stream.out" 2>/dev/null; then break; fi
  if ! kill -0 "${STREAM_PID}" 2>/dev/null; then
    wait "${STREAM_PID}" 2>/dev/null || true
    if grep -q "^done" "${OUT}/stream.out" 2>/dev/null; then break; fi
    echo "FAIL: stream process ended before done (premature completion after ${N}s of the 30s deadline, no rerun)"
    STREAM_PREMATURE=1
    break
  fi
  sleep 1
  N=$((N + 1))
done
if [ "${STREAM_PREMATURE}" = "1" ]; then exit 1; fi
if [ "${N}" -ge 30 ] && ! grep -q "^done" "${OUT}/stream.out" 2>/dev/null; then
  echo "FAIL: no done frame within the 30s deadline (no rerun)"
  exit 1
fi
kill "${STREAM_PID}" 2>/dev/null || true
wait "${STREAM_PID}" 2>/dev/null || true
echo "--- stream stdout ---"
cat "${OUT}/stream.out"
echo "--- stream stderr ---"
cat "${OUT}/stream.stderr"
grep -q "^entry " "${OUT}/stream.out" || { echo "FAIL: stream stdout missing entry frame"; exit 1; }
grep -q "^done" "${OUT}/stream.out" || { echo "FAIL: stream stdout missing done frame"; exit 1; }
echo "stream ok: entry+done frames on stdout"

echo "### 17 second view: the stream turn persisted in entries and meta"
STREAM_FULL="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${STREAM_FULL}" > "${OUT}/entries-after-stream.json"
STREAM_META="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${STREAM_META}" > "${OUT}/meta-after-stream.json"
node -e "
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync('${OUT}/full.json', 'utf8'));
const after = JSON.parse(fs.readFileSync('${OUT}/entries-after-stream.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('${OUT}/meta-after-stream.json', 'utf8'));
if (after.count <= before.count) throw new Error('stream turn wrote no entries: ' + before.count + ' -> ' + after.count);
const last = after.entries.at(-1).cursor;
if (meta.head !== last) throw new Error('meta head ' + meta.head + ' must equal last cursor ' + last);
if (meta.count !== after.entries.length) throw new Error('meta count must equal replay length');
if (meta.openRun !== null) throw new Error('stream path must leave openRun null, got ' + JSON.stringify(meta.openRun));
console.log('persisted ok: ' + before.count + ' -> ' + after.count + ' entries, head=' + meta.head);
" || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
