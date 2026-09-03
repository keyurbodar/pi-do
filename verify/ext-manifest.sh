#!/bin/sh
# ext-manifest.sh — proves manifest-form VFS extensions: a package.json
# subdir with pi.extensions plus its entry file loads and its tool invokes,
# a bad manifest fails the turn with a hint naming its own subdir, deleting
# only that subdir restores the turn, direct .ts files keep working beside
# manifests. Self-contained (no BASE server); fresh workspaceId per run.
# Exit 0 on pass, 1 otherwise.
# Writes artifacts/RUN_ID/ext-manifest/.
set -u
RUN_ID="verify-$(date +%s)"
export RUN_ID
OUT="artifacts/${RUN_ID}/ext-manifest"
mkdir -p "${OUT}"

{
echo "### Manifest extension battery (packages/pi-cf/verify-ext-manifest.mjs)"
node packages/pi-cf/verify-ext-manifest.mjs || exit 1

echo "### artifacts present (second view files on disk)"
for f in run.json entries.json commands.json bad.json removed.json run2.json; do
  if [ ! -s "${OUT}/${f}" ]; then
    echo "FAIL missing artifact ${OUT}/${f}"
    exit 1
  fi
done
echo "artifacts ok: run.json entries.json commands.json bad.json removed.json run2.json"

echo "PASS ${RUN_ID}"
} 2>&1 | tee "${OUT}/transcript.txt"
