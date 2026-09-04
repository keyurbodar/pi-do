#!/bin/sh
# entry-parents.sh — proves MEM-01 parent links plus the session leaf: mint a
# session, run two turns over the same path the agent loop persists (stub
# when the server is keyless, a real opencode-go model turn when it is
# keyed), re-read entries, assert every entry carries parent equal to the
# previous cursor (first equals 0), meta leaf equals head equals the last
# cursor, and the pre-existing replay behavior is unchanged (paged concat
# equals the full replay, after-filter replays the tail, zero interrupted
# entries on the clean path).
# Additive note: entries gain {parent} and meta gains {leaf}; no
# pre-existing field changed value or meaning. session-persist.sh,
# entries-replay.sh, and cli-proof.sh staying green is the byte-identity
# proof for those fields. The secret never enters any artifact (redaction
# grep at the end proves it when OPENCODE_API_KEY is set).
# Usage: sh verify/entry-parents.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/entry-parents/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/entry-parents"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the turns read"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 run two turns (stub keyless, real model when keyed)"
RUN1_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read ${SEED_PATH}" --base "${BASE}" --json)" || exit 1
echo "${RUN1_JSON}"
printf '%s' "${RUN1_JSON}" > "${OUT}/run1.json"
RUN2_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read ${SEED_PATH} again" --base "${BASE}" --json)" || exit 1
echo "${RUN2_JSON}"
printf '%s' "${RUN2_JSON}" > "${OUT}/run2.json"
node -e "
const fs = require('node:fs');
for (const f of ['${OUT}/run1.json', '${OUT}/run2.json']) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(f + ' via=' + r.runtime.via + ' model=' + r.runtime.provider + '/' + r.runtime.model);
}
" || exit 1

echo "### 5 re-read entries (second view: raw replay)"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
echo "${ENTRIES_JSON}"
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const entries = replay.entries;
if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries must be a non-empty array');
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i + ': ' + JSON.stringify(cursors));
}
console.log('cursor order ok: ' + cursors.length + ' entries, no gaps');
for (const e of entries) {
  if (typeof e.cursor !== 'number' || typeof e.type !== 'string' || typeof e.body !== 'string') {
    throw new Error('pre-existing entry field missing or mistyped: ' + JSON.stringify(e).slice(0, 120));
  }
  if (typeof e.parent !== 'number') throw new Error('entry missing numeric parent at cursor ' + e.cursor);
}
for (let i = 0; i < entries.length; i++) {
  const want = i === 0 ? 0 : entries[i - 1].cursor;
  if (entries[i].parent !== want) {
    throw new Error('parent break at index ' + i + ': cursor ' + entries[i].cursor + ' has parent ' + entries[i].parent + ', want ' + want);
  }
}
console.log('parent chain ok: first parent=0, every later parent equals the previous cursor');
const interrupted = entries.filter((e) => e.type === 'interrupted');
if (interrupted.length !== 0) throw new Error('expected zero interrupted entries, got ' + interrupted.length);
console.log('zero interrupted ok');
" || exit 1

echo "### 6 meta leaf equals head equals last cursor (second view)"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
echo "${META_JSON}"
printf '%s' "${META_JSON}" > "${OUT}/meta.json"
node -e "
const fs = require('node:fs');
const m = JSON.parse(fs.readFileSync('${OUT}/meta.json', 'utf8'));
const full = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const last = full.entries.at(-1).cursor;
if (m.sid !== '${SID}') throw new Error('meta sid mismatch');
if (typeof m.head !== 'number' || typeof m.count !== 'number' || typeof m.leaf !== 'number') {
  throw new Error('meta must carry numeric { head, count, leaf }');
}
if (m.head !== last) throw new Error('meta head ' + m.head + ' must equal last cursor ' + last);
if (m.leaf !== m.head) throw new Error('meta leaf ' + m.leaf + ' must equal head ' + m.head);
if (m.count !== full.entries.length) throw new Error('meta count must equal replay length');
if (full.head !== m.head || full.count !== m.count) throw new Error('entries head/count must match meta');
if (m.openRun !== null) throw new Error('clean path must have openRun null, got ' + JSON.stringify(m.openRun));
console.log('leaf ok: leaf=' + m.leaf + ' head=' + m.head + ' count=' + m.count + ' openRun=null');
" || exit 1

echo "### 7 paged replay still byte-equals the full replay"
AFTER=0
N=0
while true; do
  PAGE_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after "${AFTER}" --limit 3 --base "${BASE}" --json)" || exit 1
  printf '%s' "${PAGE_JSON}" > "${OUT}/page-${N}.json"
  GOT="$(node -p "JSON.parse(process.argv[1]).entries.length" "${PAGE_JSON}")"
  if [ "${GOT}" -eq 0 ]; then break; fi
  if [ "${GOT}" -gt 3 ]; then echo "page larger than limit"; exit 1; fi
  AFTER="$(node -p "JSON.parse(process.argv[1]).entries.at(-1).cursor" "${PAGE_JSON}")"
  N=$((N + 1))
  if [ "${N}" -gt 100 ]; then echo "paging did not terminate"; exit 1; fi
done
export PAGES="${N}"
node -e "
const fs = require('node:fs');
const path = require('node:path');
const pages = Number(process.env.PAGES);
const full = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8')).entries;
const paged = [];
for (let i = 0; i < pages; i++) {
  paged.push(...JSON.parse(fs.readFileSync(path.join('${OUT}', 'page-' + i + '.json'), 'utf8')).entries);
}
if (JSON.stringify(paged) !== JSON.stringify(full)) throw new Error('paged replay differs from full replay');
console.log('paged replay byte-equals full replay: ' + paged.length + ' entries');
" || exit 1

echo "### 8 secret never enters the artifacts"
if [ -n "${OPENCODE_API_KEY:-}" ]; then
  if grep -rF -- "${OPENCODE_API_KEY}" "${OUT}" > "${OUT}/redact-hit.txt" 2>&1; then
    echo "secret material found in artifacts"
    exit 1
  fi
  echo "redaction ok: no secret material in ${OUT}"
else
  echo "redaction skipped: OPENCODE_API_KEY absent from caller env"
fi

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
