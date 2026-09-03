#!/bin/sh
# session-persist.sh — proves every harness event persists before emit: mint a
# session, run two headless turns, re-read entries, assert cursor order with
# no gaps, every toolCall id from both runs present as entries, and zero
# interrupted entries on the clean path.
# Usage: sh verify/session-persist.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/session-persist/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/session-persist"
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
RUN1_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt" --base "${BASE}" --json)" || exit 1
echo "${RUN1_JSON}"
printf '%s' "${RUN1_JSON}" > "${OUT}/run1.json"
RUN2_JSON="$(${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed.txt again" --base "${BASE}" --json)" || exit 1
echo "${RUN2_JSON}"
printf '%s' "${RUN2_JSON}" > "${OUT}/run2.json"

echo "### 5 re-read entries (second view: raw replay)"
ENTRIES_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --base "${BASE}" --json)" || exit 1
echo "${ENTRIES_JSON}"
printf '%s' "${ENTRIES_JSON}" > "${OUT}/entries.json"
node -e "
const fs = require('node:fs');
const runs = [JSON.parse(fs.readFileSync('${OUT}/run1.json', 'utf8')), JSON.parse(fs.readFileSync('${OUT}/run2.json', 'utf8'))];
const replay = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8'));
const entries = replay.entries;
if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries must be a non-empty array');
// Cursor order with no gaps.
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i + ': ' + JSON.stringify(cursors));
}
console.log('cursor order ok: ' + cursors.length + ' entries, no gaps');
// Every toolCall id from both runs present as entries (multiset match).
const want = runs.flatMap((r) => (r.toolCalls || []).map((c) => c.id)).sort();
const got = entries.filter((e) => e.type === 'toolCall').map((e) => JSON.parse(e.body).id).sort();
if (JSON.stringify(want) !== JSON.stringify(got)) {
  throw new Error('toolCall id mismatch: runs ' + JSON.stringify(want) + ' entries ' + JSON.stringify(got));
}
console.log('toolCall ids ok: ' + JSON.stringify(want));
// Zero interrupted entries on the clean path.
const interrupted = entries.filter((e) => e.type === 'interrupted');
if (interrupted.length !== 0) throw new Error('expected zero interrupted entries, got ' + interrupted.length);
console.log('zero interrupted ok');
" || exit 1

echo "### 6 entries after-filter replays the tail"
TAIL_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 2 --base "${BASE}" --json)" || exit 1
printf '%s' "${TAIL_JSON}" > "${OUT}/tail.json"
node -e "
const fs = require('node:fs');
const full = JSON.parse(fs.readFileSync('${OUT}/entries.json', 'utf8')).entries;
const tail = JSON.parse(fs.readFileSync('${OUT}/tail.json', 'utf8')).entries;
const want = full.filter((e) => e.cursor > 2);
if (JSON.stringify(tail) !== JSON.stringify(want)) throw new Error('after-filter mismatch');
console.log('after-filter ok: ' + tail.length + ' entries past cursor 2');
" || exit 1

echo "### 7 unknown workspace entries is 404 with a hint"
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

echo "### 8 unknown session entries is 404 with a hint"
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

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
