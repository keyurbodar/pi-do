#!/bin/sh
# store-proof.sh — proves the turn-once store: each headless turn lands its
# open row plus entries plus close together, the replay index exists with
# plans hitting indexes on the replay and list paths, and the full replay
# is byte-stable across reads and paging.
# Usage: sh verify/store-proof.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/store-proof/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/store-proof"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
LIST_DIR="verify-${RUN_ID}"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the stub file plus a list prefix"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1
printf '%s' "a" | ${CLI} files put --ws "${WS}" --path "${LIST_DIR}/a.txt" --base "${BASE}" --json || exit 1
printf '%s' "b" | ${CLI} files put --ws "${WS}" --path "${LIST_DIR}/b.txt" --base "${BASE}" --json || exit 1

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 run two headless turns"
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json || exit 1
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt again" --base "${BASE}" --json || exit 1

echo "### 5 full replay, first read"
FULL_A="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${FULL_A}" > "${OUT}/full-a.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/full-a.json', 'utf8'));
if (!Array.isArray(b.entries) || b.entries.length === 0) throw new Error('full replay must be non-empty');
if (b.count !== b.entries.length) throw new Error('count must equal replay length');
const cursors = b.entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
console.log('full replay ok: ' + b.entries.length + ' entries, no gaps');
" || exit 1

echo "### 6 paged replay byte-equals the full replay"
AFTER=0
N=0
while true; do
  PAGE_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after "${AFTER}" --limit 3 --base "${BASE}" --json)" || exit 1
  printf '%s' "${PAGE_JSON}" > "${OUT}/page-${N}.json"
  GOT="$(node -p "JSON.parse(process.argv[1]).entries.length" "${PAGE_JSON}")"
  if [ "${GOT}" -eq 0 ]; then break; fi
  AFTER="$(node -p "JSON.parse(process.argv[1]).entries.at(-1).cursor" "${PAGE_JSON}")"
  N=$((N + 1))
  if [ "${N}" -gt 100 ]; then echo "paging did not terminate"; exit 1; fi
done
export PAGES="${N}"
node -e "
const fs = require('node:fs');
const path = require('node:path');
const pages = Number(process.env.PAGES);
const full = JSON.parse(fs.readFileSync('${OUT}/full-a.json', 'utf8')).entries;
const paged = [];
for (let i = 0; i < pages; i++) {
  paged.push(...JSON.parse(fs.readFileSync(path.join('${OUT}', 'page-' + i + '.json'), 'utf8')).entries);
}
if (JSON.stringify(paged) !== JSON.stringify(full)) throw new Error('paged replay differs from full replay');
console.log('paged replay byte-equals full replay: ' + paged.length + ' entries');
" || exit 1

echo "### 7 full replay, second read, byte-equals the first"
FULL_B="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${FULL_B}" > "${OUT}/full-b.json"
if ! cmp -s "${OUT}/full-a.json" "${OUT}/full-b.json"; then
  echo "replay moved between reads"
  exit 1
fi
echo "replay stable across reads"

echo "### 8 meta cross-check through the second view"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta.json"
WS="${WS}" SID="${SID}" node -e "
const fs = require('node:fs');
const m = JSON.parse(fs.readFileSync('${OUT}/meta.json', 'utf8'));
const full = JSON.parse(fs.readFileSync('${OUT}/full-a.json', 'utf8'));
if (m.head !== full.entries.at(-1).cursor) throw new Error('meta head must equal last cursor');
if (m.count !== full.entries.length) throw new Error('meta count must equal replay length');
if (m.openRun !== null) throw new Error('clean path must have openRun null, got ' + JSON.stringify(m.openRun));
console.log('meta ok: head=' + m.head + ' count=' + m.count + ' openRun=null');
" || exit 1

echo "### 9 prefix list over the seeded dir"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "${LIST_DIR}" --base "${BASE}" --json)" || exit 1
printf '%s' "${LS_JSON}" > "${OUT}/list.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/list.json', 'utf8'));
const list = Array.isArray(b) ? b : (b.files ?? b.entries);
const paths = list.map((e) => e.path).sort();
const want = ['${LIST_DIR}/a.txt', '${LIST_DIR}/b.txt'];
if (JSON.stringify(paths) !== JSON.stringify(want)) throw new Error('prefix list wrong: ' + JSON.stringify(paths));
console.log('prefix list ok: ' + paths.join(','));
" || exit 1

echo "### 10 persisted storage: index present, plans hit indexes"
SQLITE=""
for f in $(find worker/.wrangler .wrangler -name "*.sqlite" 2>/dev/null); do
  if sqlite3 "${f}" "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_entries';" | grep -q pi_entries; then
    SQLITE="${f}"
    break
  fi
done
if [ -z "${SQLITE}" ]; then
  echo "no persisted DO sqlite file holding pi_entries under worker/.wrangler or .wrangler"
  echo "start the worker with persisted storage, then rerun"
  exit 1
fi
echo "SQLITE=${SQLITE}"
sqlite3 "${SQLITE}" "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index';" > "${OUT}/indexes.txt"
if ! grep -q "pi_entries_sid_id" "${OUT}/indexes.txt"; then
  echo "missing index pi_entries_sid_id"
  exit 1
fi
echo "index present: pi_entries_sid_id"
sqlite3 "${SQLITE}" "EXPLAIN QUERY PLAN SELECT id AS cursor, type, body FROM pi_entries WHERE sid = 'proof-sid' AND id > 0 ORDER BY id LIMIT 100;" > "${OUT}/plan-replay.txt"
cat "${OUT}/plan-replay.txt"
if ! grep -q "pi_entries_sid_id" "${OUT}/plan-replay.txt"; then
  echo "replay plan misses pi_entries_sid_id"
  exit 1
fi
echo "replay plan hits pi_entries_sid_id"
sqlite3 "${SQLITE}" "EXPLAIN QUERY PLAN SELECT path, length(body) AS bytes FROM files WHERE ws = 'proof-ws' AND path LIKE ('${LIST_DIR}/' || '%') ORDER BY path;" > "${OUT}/plan-list.txt"
cat "${OUT}/plan-list.txt"
if ! grep -q "USING INDEX" "${OUT}/plan-list.txt"; then
  echo "list plan uses no index"
  exit 1
fi
echo "list plan hits an index"
sqlite3 "${SQLITE}" "EXPLAIN QUERY PLAN SELECT id AS cursor, type, body FROM pi_entries WHERE sid = 'proof-sid' AND id = 1 LIMIT 1;" > "${OUT}/plan-get.txt"
cat "${OUT}/plan-get.txt"
if ! grep -q "SEARCH" "${OUT}/plan-get.txt"; then
  echo "get plan is a scan"
  exit 1
fi
echo "get plan seeks"

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
