#!/bin/sh
# entries-replay.sh — proves resume-grade paged replay: mint a session, run two
# headless turns, page entries with limit=3, assert concatenation byte-equals
# the full replay in cursor order, assert meta head equals the last cursor with
# openRun null on the clean path, and assert ws/sid 404s carry hints. Closes
# with the verify-runs unit pass, which covers the interrupted path (an
# unclosed run stays open) that the headless harness never exposes.
# Usage: sh verify/entries-replay.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/entries-replay/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/entries-replay"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed the file the stub reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1

echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 run two headless turns"
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json || exit 1
${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt again" --base "${BASE}" --json || exit 1

echo "### 5 full replay (default limit)"
FULL_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
printf '%s' "${FULL_JSON}" > "${OUT}/full.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/full.json', 'utf8'));
if (!Array.isArray(b.entries) || b.entries.length === 0) throw new Error('full replay must be non-empty');
if (typeof b.head !== 'number' || typeof b.count !== 'number') throw new Error('entries must carry { head, count }');
if (b.count !== b.entries.length) throw new Error('count must equal replay length');
console.log('full replay ok: ' + b.entries.length + ' entries head=' + b.head + ' count=' + b.count);
" || exit 1

echo "### 6 page with limit=3 until an empty page"
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

echo "### 7 meta head equals last cursor, openRun null on the clean path"
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
echo "${META_JSON}"
printf '%s' "${META_JSON}" > "${OUT}/meta.json"
WS="${WS}" SID="${SID}" node -e "
const fs = require('node:fs');
const m = JSON.parse(fs.readFileSync('${OUT}/meta.json', 'utf8'));
const full = JSON.parse(fs.readFileSync('${OUT}/full.json', 'utf8'));
const last = full.entries.at(-1).cursor;
if (m.sid !== process.env.SID) throw new Error('meta sid mismatch');
if (m.ws !== process.env.WS) throw new Error('meta ws mismatch');
if (typeof m.created !== 'string' || m.created.length === 0) throw new Error('meta created must be a non-empty string');
if (m.head !== last) throw new Error('meta head ' + m.head + ' must equal last cursor ' + last);
if (m.count !== full.entries.length) throw new Error('meta count must equal replay length');
if (m.openRun !== null) throw new Error('clean path must have openRun null, got ' + JSON.stringify(m.openRun));
if (full.head !== m.head || full.count !== m.count) throw new Error('entries head/count must match meta');
console.log('meta ok: head=' + m.head + ' count=' + m.count + ' openRun=null');
" || exit 1

echo "### 8 unknown workspace entries is 404 with a hint"
if ${CLI} entries --ws "nope-${RUN_ID}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/missing-ws.json" 2> "${OUT}/missing-ws.stderr"; then
  echo "expected entries against unknown workspace to fail"
  exit 1
fi
cat "${OUT}/missing-ws.json" "${OUT}/missing-ws.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/missing-ws.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" || exit 1

echo "### 9 unknown session entries is 404 with a hint"
if ${CLI} entries --ws "${WS}" --sid "nope-${RUN_ID}" --base "${BASE}" --json > "${OUT}/missing-sid.json" 2> "${OUT}/missing-sid.stderr"; then
  echo "expected entries against unknown session to fail"
  exit 1
fi
cat "${OUT}/missing-sid.json" "${OUT}/missing-sid.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/missing-sid.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" || exit 1

echo "### 10 unknown workspace meta is 404 with a hint"
if ${CLI} meta --ws "nope-${RUN_ID}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-missing-ws.json" 2> "${OUT}/meta-missing-ws.stderr"; then
  echo "expected meta against unknown workspace to fail"
  exit 1
fi
cat "${OUT}/meta-missing-ws.json" "${OUT}/meta-missing-ws.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-missing-ws.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" || exit 1

echo "### 11 unknown session meta is 404 with a hint"
if ${CLI} meta --ws "${WS}" --sid "nope-${RUN_ID}" --base "${BASE}" --json > "${OUT}/meta-missing-sid.json" 2> "${OUT}/meta-missing-sid.stderr"; then
  echo "expected meta against unknown session to fail"
  exit 1
fi
cat "${OUT}/meta-missing-sid.json" "${OUT}/meta-missing-sid.stderr"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-missing-sid.json', 'utf8'));
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" || exit 1

echo "### 12 interrupted-path unit coverage (harness never leaves runs open)"
node packages/pi-cf/verify-runs.mjs || exit 1

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
