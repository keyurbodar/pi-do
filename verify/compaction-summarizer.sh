#!/bin/sh
# compaction-summarizer.sh — proves the compaction trigger and summary seam
# over the shipped modules (no server, no mocks): the live token estimate is
# exact at the last usage-bearing result entry plus chars/4 for entries after
# it (whole-chain chars/4 when no usage exists), the compaction mark resolves
# the session's model contextWindow instead of a hardcoded budget, an
# injected summarizer owns the persisted compaction entry's body.summary and
# receives the previous compaction's summary on a re-compaction, and a
# throwing or empty summarizer degrades to the deterministic summary without
# failing the compaction.
# Usage: sh verify/compaction-summarizer.sh
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/compaction-summarizer/.
set -u
RUN_ID="verify-$(date +%s)"
OUT="$(pwd)/artifacts/${RUN_ID}/compaction-summarizer"
mkdir -p "${OUT}"

{
cd worker
node --test test/compaction-summarizer.test.mjs 2>&1 | tee "${OUT}/test-transcript.txt"
SUMMARY="$(grep -E 'pass [0-9]+|fail [0-9]+' "${OUT}/test-transcript.txt" | tail -4)"
echo "${SUMMARY}"
PASSES="$(grep -E '^. pass [0-9]+' "${OUT}/test-transcript.txt" | grep -oE '[0-9]+')"
FAILS="$(grep -E '^. fail [0-9]+' "${OUT}/test-transcript.txt" | grep -oE '[0-9]+')"
if [ -z "${PASSES}" ] || [ "${PASSES}" -lt 4 ] || [ "${FAILS}" != "0" ]; then
  echo "expected 4 passing tests and 0 failures, got pass=${PASSES} fail=${FAILS}"
  exit 1
fi
echo "PASS ${RUN_ID} usage-exact-estimate"
echo "PASS ${RUN_ID} session-context-window-trigger"
echo "PASS ${RUN_ID} model-summary-and-chained-previous-summary"
echo "PASS ${RUN_ID} degrade-to-deterministic"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
