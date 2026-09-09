#!/bin/sh
# fast-battery.sh — local-only verify tier, no inference, no own wrangler boot.
# Usage: sh verify/fast-battery.sh [BASE]
# Runs every script that passes against the already-running dev server, 8-wide.
# Target: whole tier green in under 2 minutes.
# Excluded on purpose: bg-process (kill-storm crashes wrangler dev, see
# worker/src/shell-exec.ts bgKill), keyed-* plus live-models (real provider
# inference, minutes each), hibernate-proof (needs a manual dev restart).
set -u
BASE="${1:-http://127.0.0.1:8787}"
OUTDIR="artifacts/fast-battery"
mkdir -p "${OUTDIR}"
set -- doctor git-smoke git-writes cli-proof entries-replay entry-parents \
  session-persist store-proof files-roundtrip exec-smoke fence-cas \
  stream-protocol context-build retention-long model-switch shell-caps \
  tools-smoke queue-order compaction-proof keyed-runtime
export OUTDIR BASE
printf '%s\n' "$@" | xargs -P 8 -I{} sh -c 'n="$1"; sh verify/"$n".sh "$BASE" > "$OUTDIR/$n.txt" 2>&1; code=$?; if [ "$n" = "doctor" ]; then if [ "$code" = "0" ]; then echo "PASS $n"; else echo "FAIL $n"; fi; elif grep -qm1 "^PASS" "$OUTDIR/$n.txt"; then echo "PASS $n"; else echo "FAIL $n"; fi' sh {}
