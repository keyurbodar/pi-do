#!/bin/sh
# parallel battery: runs verify scripts concurrently against one BASE.
# usage: sh verify/parallel-battery.sh [BASE] [name...]
# default set is the keyed smoke tier (burst plus keyed-live deleted as
# redundant; eviction needs its own port, live-models takes no BASE arg).
# width is 2: one provider key rate-limits, and contention flakes when three
# or more keyed scripts race it.
# Chaos map: the keyed smoke tier above shares one BASE at width 2, so any
# script that kills or owns its server stays out — sigkill-e2e (kill -9s its
# own :8793 server mid-turn; same reason bg-process and hibernate-proof are
# excluded from shared tiers), keyed-spark-eviction (kill -9s workerd on its
# port, owned or taken over), eviction-repro (manual operator-restart lane on
# an isolated BASE, never kills itself). quota-refusal is shared-dev safe and
# parallel-eligible (no boots/kills, one cheap capped turn plus a passive scan
# window); it runs solo until the root adopts it into the default set above.
set -u
BASE="${1:-http://127.0.0.1:8787}"
if [ "$#" -gt 0 ]; then shift; fi
OUTDIR="artifacts/wave1m"
mkdir -p "${OUTDIR}"
if [ "$#" = "0" ]; then
  set -- keyed-spark-abort keyed-spark-archive keyed-spark-contention keyed-spark-factory keyed-spark-summary keyed-spark-thinking keyed-spark-steer keyed-spark-stream
fi
export OUTDIR BASE
printf '%s\n' "$@" | xargs -P 2 -I{} sh -c '
  n="$1"
  if [ "$n" = "live-models" ]; then sh verify/"$n".sh > "$OUTDIR/$n.txt" 2>&1 & P=$!;
  else sh verify/"$n".sh "$BASE" > "$OUTDIR/$n.txt" 2>&1 & P=$!; fi;
  (sleep 420; kill -STOP "$P" 2>/dev/null; for _c in $(pgrep -P "$P" 2>/dev/null); do pkill -STOP -P "$_c" 2>/dev/null; done; pkill -STOP -P "$P" 2>/dev/null; for _c in $(pgrep -P "$P" 2>/dev/null); do pkill -9 -P "$_c" 2>/dev/null; kill -9 "$_c" 2>/dev/null; done; pkill -9 -P "$P" 2>/dev/null; kill -9 "$P" 2>/dev/null) 2>/dev/null & W=$!;
  wait "$P" 2>/dev/null; code=$?; kill "$W" 2>/dev/null; wait "$W" 2>/dev/null;
  if [ "$code" != "0" ]; then echo "FAIL $n (exit $code)"; elif grep -Eqm1 "^PASS.*BLOCKED|^BLOCKED" "$OUTDIR/$n.txt"; then r=$(grep -E -m1 "^PASS.*BLOCKED|^BLOCKED" "$OUTDIR/$n.txt" | sed "s/^.*BLOCKED *//;s/ *$//"); if [ -z "$r" ]; then echo "PASS $n (BLOCKED)"; else echo "PASS $n (BLOCKED $r)"; fi; else if node -e "process.exit(/^PASS/m.test(require(\"fs\").readFileSync(\"$OUTDIR/$n.txt\",\"utf8\"))?0:1)"; then echo "PASS $n"; else echo "FAIL $n"; fi; fi' sh {}
