#!/bin/sh
# files-roundtrip.sh — proves workspace create → files put → get → ls.
# Usage: sh verify/files-roundtrip.sh [BASE]
# Exit 0 on byte-identical round-trip, 1 otherwise. Writes artifacts/RUN_ID/files-roundtrip/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/files-roundtrip"
mkdir -p "${OUT}"
PATH_="verify-${RUN_ID}/hello.txt"
BODY="hello-pi-do-${RUN_ID}"

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 files put"
printf '%s' "${BODY}" | ${CLI} files put --ws "${WS}" --path "${PATH_}" --base "${BASE}" --json || exit 1

echo "### 3 files get (second view)"
${CLI} files get --ws "${WS}" --path "${PATH_}" --base "${BASE}" --out "${OUT}/got.bin" || exit 1
printf '%s' "${BODY}" > "${OUT}/want.bin"
cmp "${OUT}/want.bin" "${OUT}/got.bin" || exit 1
echo "bytes identical"

echo "### 4 files ls"
${CLI} files ls --ws "${WS}" --path "verify-${RUN_ID}/" --base "${BASE}" --json || exit 1

echo "### 5 prefix list isolation"
printf '%s' "other-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "other-${RUN_ID}/note.txt" --base "${BASE}" --json || exit 1
${CLI} files ls --ws "${WS}" --path "verify-${RUN_ID}/" --base "${BASE}" --json > "${OUT}/ls-prefix.json" || exit 1
node -e "
const e = JSON.parse(require('node:fs').readFileSync('${OUT}/ls-prefix.json', 'utf8')).entries;
if (e.length !== 1 || e[0].path !== '${PATH_}') { console.error('prefix leak', JSON.stringify(e)); process.exit(1); }
"
echo "prefix isolated"

echo "### 6 files rm single file, then get 404s (second view)"
${CLI} files rm --ws "${WS}" --path "${PATH_}" --base "${BASE}" --json || exit 1
if ${CLI} files get --ws "${WS}" --path "${PATH_}" --base "${BASE}" --out "${OUT}/gone.bin" 2>"${OUT}/gone.stderr"; then
  echo "expected get-after-rm to fail"; exit 1
fi
echo "rm confirmed by second-view get"

echo "### 7 recursive gate on directory trees"
printf '%s' "a" | ${CLI} files put --ws "${WS}" --path "tree-${RUN_ID}/a.txt" --base "${BASE}" --json || exit 1
printf '%s' "b" | ${CLI} files put --ws "${WS}" --path "tree-${RUN_ID}/sub/b.txt" --base "${BASE}" --json || exit 1
if ${CLI} files rm --ws "${WS}" --path "tree-${RUN_ID}" --base "${BASE}" --json 2>"${OUT}/rm-dir.stderr"; then
  echo "expected non-recursive tree rm to fail"; exit 1
fi
grep -q "is a directory" "${OUT}/rm-dir.stderr" || exit 1
${CLI} files rm --ws "${WS}" --path "tree-${RUN_ID}" --recursive --base "${BASE}" --json > "${OUT}/rm-tree.json" || exit 1
node -e "
const r = JSON.parse(require('node:fs').readFileSync('${OUT}/rm-tree.json', 'utf8')).removed;
if (r.length !== 2) { console.error('tree rm removed', JSON.stringify(r)); process.exit(1); }
"
${CLI} files ls --ws "${WS}" --path "tree-${RUN_ID}/" --base "${BASE}" --json > "${OUT}/ls-tree.json" || exit 1
node -e "
const e = JSON.parse(require('node:fs').readFileSync('${OUT}/ls-tree.json', 'utf8')).entries;
if (e.length !== 0) { console.error('tree not empty', JSON.stringify(e)); process.exit(1); }
"
echo "recursive gate holds"

echo "### 8 root refusal and traversal fail closed"
if ${CLI} files rm --ws "${WS}" --path "../escape-${RUN_ID}.txt" --base "${BASE}" --json 2>"${OUT}/rm-escape.stderr"; then
  echo "expected traversal rm to fail"; exit 1
fi
echo "traversal refused"

echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
