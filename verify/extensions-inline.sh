#!/bin/sh
# extensions-inline.sh — proves inline extensions on a foreign host: build
# createPiCf with the sample extension over node:sqlite, run one keyless stub
# turn invoking the sample tool, assert entries show the tool call plus
# result, the command map lists the sample command, and the hook marker is
# present. Self-contained (no BASE server); fresh workspaceId per run.
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/extensions-inline/.
set -u
RUN_ID="verify-$(date +%s)"
export RUN_ID
OUT="artifacts/${RUN_ID}/extensions-inline"
mkdir -p "${OUT}"

{
echo "### foreign host battery (packages/pi-cf/verify-extensions.mjs)"
node packages/pi-cf/verify-extensions.mjs || exit 1

echo "### artifacts present (second view files on disk)"
for f in run.json entries.json commands.json; do
  if [ ! -s "${OUT}/${f}" ]; then
    echo "FAIL missing artifact ${OUT}/${f}"
    exit 1
  fi
done
echo "artifacts ok: run.json entries.json commands.json"

echo "PASS ${RUN_ID}"
} 2>&1 | tee "${OUT}/transcript.txt"
