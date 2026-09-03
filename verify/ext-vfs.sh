#!/bin/sh
# ext-vfs.sh — proves VFS extensions: write a sample extension file into
# .pi/extensions via the files route, run a stub turn invoking its tool,
# assert entries show the tool call plus result, then remove the file and
# prove the tool is gone next turn. Self-contained (no BASE server); fresh
# workspaceId per run. Exit 0 on pass, 1 otherwise.
# Writes artifacts/RUN_ID/ext-vfs/.
set -u
RUN_ID="verify-$(date +%s)"
export RUN_ID
OUT="artifacts/${RUN_ID}/ext-vfs"
mkdir -p "${OUT}"

{
echo "### VFS extension battery (packages/pi-cf/verify-ext-vfs.mjs)"
node packages/pi-cf/verify-ext-vfs.mjs || exit 1

echo "### artifacts present (second view files on disk)"
for f in run.json entries.json commands.json removed.json run2.json; do
  if [ ! -s "${OUT}/${f}" ]; then
    echo "FAIL missing artifact ${OUT}/${f}"
    exit 1
  fi
done
echo "artifacts ok: run.json entries.json commands.json removed.json run2.json"

echo "PASS ${RUN_ID}"
} 2>&1 | tee "${OUT}/transcript.txt"
