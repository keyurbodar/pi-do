#!/bin/sh
# fast-battery.sh — local-only verify tier, no inference, no own wrangler boot.
# Usage: sh verify/fast-battery.sh [BASE]
# Runs every script that passes against the already-running dev server, 8-wide.
# Target: whole tier green in under 2 minutes.
# Excluded on purpose: bg-process (kill-storm crashes wrangler dev, see
# worker/src/shell-exec.ts bgKill), keyed-* plus live-models (real provider
# inference, minutes each), hibernate-proof (needs a manual dev restart).
# Chaos map (kill scripts): sigkill-e2e owns its server on :8793 and kill -9s
# it mid-turn, keyed-spark-eviction owns or takes over its port and kill -9s
# workerd, bg-process kill-storms the shared server, hibernate-proof needs a
# manual dev restart, and eviction-repro needs an operator restart on an
# isolated keyed BASE — none of them run in this tier. quota-refusal is the
# exception that proves the rule: shared-dev safe (boots/kills nothing), so it
# stays eligible for the parallel keyed tier, never this local-only tier (which
# takes no inference at all).
set -u
BASE="${1:-http://127.0.0.1:8787}"
OUTDIR="artifacts/fast-battery"
mkdir -p "${OUTDIR}"
set -- doctor git-smoke git-writes cli-proof entries-replay entry-parents \
  session-persist store-proof files-roundtrip exec-smoke fence-cas \
  stream-protocol context-build retention-long model-switch shell-caps \
  tools-smoke queue-order compaction-proof keyed-runtime
export OUTDIR BASE
printf '%s\n' "$@" | xargs -P 4 -I{} sh -c 'n="$1"; sh verify/"$n".sh "$BASE" > "$OUTDIR/$n.txt" 2>&1 & P=$!;
  (sleep 420; kill -STOP "$P" 2>/dev/null; for _c in $(pgrep -P "$P" 2>/dev/null); do pkill -STOP -P "$_c" 2>/dev/null; done; pkill -STOP -P "$P" 2>/dev/null; for _c in $(pgrep -P "$P" 2>/dev/null); do pkill -9 -P "$_c" 2>/dev/null; kill -9 "$_c" 2>/dev/null; done; pkill -9 -P "$P" 2>/dev/null; kill -9 "$P" 2>/dev/null) 2>/dev/null & W=$!;
  wait "$P" 2>/dev/null; code=$?; kill "$W" 2>/dev/null; wait "$W" 2>/dev/null;
  if [ "$n" = "doctor" ]; then if [ "$code" = "0" ]; then echo "PASS $n"; else echo "FAIL $n"; fi;
  elif grep -Eqm1 "^PASS.*BLOCKED|^BLOCKED" "$OUTDIR/$n.txt"; then r=$(grep -E -m1 "^PASS.*BLOCKED|^BLOCKED" "$OUTDIR/$n.txt" | sed "s/^.*BLOCKED *//;s/ *$//"); if [ -z "$r" ]; then echo "PASS $n (BLOCKED)"; else echo "PASS $n (BLOCKED $r)"; fi;
  elif [ "$code" != "0" ]; then echo "FAIL $n (exit $code)";
  elif grep -qm1 "^PASS" "$OUTDIR/$n.txt"; then echo "PASS $n"; else echo "FAIL $n"; fi' sh {} | tee "${OUTDIR}/summary.txt"
! grep -qm1 "^FAIL" "${OUTDIR}/summary.txt"
