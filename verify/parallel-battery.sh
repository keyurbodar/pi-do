#!/bin/sh
# parallel battery: runs verify scripts concurrently against one BASE.
# usage: sh verify/parallel-battery.sh [BASE] [name...]
# default set is the keyed smoke tier (burst plus keyed-live deleted as
# redundant; eviction needs its own port, live-models takes no BASE arg).
# width is 2: one provider key rate-limits, and contention flakes when three
# or more keyed scripts race it.
set -u
BASE="${1:-http://127.0.0.1:8787}"
if [ "$#" -gt 0 ]; then shift; fi
OUTDIR="artifacts/wave1m"
mkdir -p "${OUTDIR}"
if [ "$#" = "0" ]; then
  set -- keyed-spark-abort keyed-spark-archive keyed-spark-contention keyed-spark-factory keyed-spark-thinking keyed-spark-steer keyed-spark-stream
fi
export OUTDIR BASE
printf '%s\n' "$@" | xargs -P 2 -I{} sh -c '
  n="$1"
  if [ "$n" = "live-models" ]; then sh verify/"$n".sh > "$OUTDIR/$n.txt" 2>&1 & P=$!;
  else sh verify/"$n".sh "$BASE" > "$OUTDIR/$n.txt" 2>&1 & P=$!; fi;
  (sleep 420; kill -9 "$P" 2>/dev/null) 2>/dev/null & W=$!;
  wait "$P"; code=$?; kill "$W" 2>/dev/null; wait "$W" 2>/dev/null;
  if [ "$code" != "0" ]; then echo "FAIL $n (exit $code)"; else if node -e "process.exit(/^PASS/m.test(require(\"fs\").readFileSync(\"$OUTDIR/$n.txt\",\"utf8\"))?0:1)"; then echo "PASS $n"; else echo "FAIL $n"; fi; fi' sh {}
