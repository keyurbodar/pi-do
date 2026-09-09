#!/bin/sh
# parallel battery: runs verify scripts concurrently against one BASE.
# usage: sh verify/parallel-battery.sh [BASE] [name...]
# default set skips keyed-spark-eviction (needs .dev.vars absent) and
# live-models (takes no BASE arg); pass them explicitly if wanted.
set -u
BASE="${1:-http://127.0.0.1:8787}"
if [ "$#" -gt 0 ]; then shift; fi
OUTDIR="artifacts/wave1m"
mkdir -p "${OUTDIR}"
if [ "$#" = "0" ]; then
  set -- keyed-spark-abort keyed-spark-archive keyed-spark-contention keyed-spark-burst keyed-spark-factory keyed-spark-thinking keyed-spark-steer keyed-spark-stream keyed-live
fi
export OUTDIR BASE
printf '%s\n' "$@" | xargs -P 4 -I{} sh -c '
  n="$1"
  if [ "$n" = "live-models" ]; then timeout 420 sh verify/"$n".sh > "$OUTDIR/$n.txt" 2>&1;
  else timeout 420 sh verify/"$n".sh "$BASE" > "$OUTDIR/$n.txt" 2>&1; fi;
  if node -e "process.exit(/^PASS/m.test(require(\"fs\").readFileSync(\"$OUTDIR/$n.txt\",\"utf8\"))?0:1)"; then echo "PASS $n"; else echo "FAIL $n"; fi' sh {}
