#!/bin/sh
# quota-refusal.sh — proves a credit-budget refusal halts cleanly on the keyed tier.
# It streams one tiny keyed turn with a near-zero maxCost budget, which trips the
# agent cost halt deterministically (halt reason "cost") for near-zero spend, then
# proves the refusal shape (done carries halt plus usage, the stored result entry
# carries the same halt, no error frames or error rows) and ledger hygiene (meta
# openRun stays null, entry cursors stay gapless, one full orphan-age window adds no
# redrive rows, and a second capped turn completes on the next revision, so the
# refused turn left no orphaned pi_runs row behind for the Wave 2 recovery scan).
# A real provider refusal (429/quota/insufficient/opt-in) on the capped turn is
# reported, not failed: the script proves what it can (error frame plus error row,
# no result row, openRun null), writes OUT/BLOCKED via record_blocked, and exits 0
# with PASS ... BLOCKED (record_blocked pattern, same as retention-long/turn-census).
# Missing-secret plumbing (session stays on stub) and a cost-free model path (usage
# costTotal 0, cap untrippable) also exit 0 BLOCKED: refusal unproven this run.
# Shared-dev safe: boots nothing, kills nothing, so it runs against the shared dev
# and is parallel-tier eligible (one cheap keyed turn plus a passive scan window).
# Usage: sh verify/quota-refusal.sh [BASE]
# Exit 0 on pass (or a named block), 1 otherwise. Writes artifacts/RUN_ID/quota-refusal/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/quota-refusal"
mkdir -p "${OUT}"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_MODEL="opencode-go/deepseek-v4-flash"
MAXCOST="0.000000001"
TINY_PROMPT="read ${SEED_PATH}, then answer in under ten words: what did it say?"
record_blocked() {
  node -e "
const fs = require('node:fs');
let b = {};
try { b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch { b = { raw: fs.readFileSync(process.argv[1], 'utf8') }; }
const text = JSON.stringify(b).toLowerCase();
if (!/429|403|rate|quota|too many|overloaded|capacity|exceeded|insufficient|billing|datapolicy|opt.in|consent|unavailable/.test(text)) {
  console.error('turn failed without a quota/provider-refusal signal: ' + JSON.stringify(b).slice(0, 300));
  process.exit(1);
}
console.log('block signal ok: ' + JSON.stringify(b).slice(0, 300));
" "$1" || exit 1
  printf '%s\n' "blocked: quota proof ($2 keyed turn ${KEYED_MODEL} with maxCost ${MAXCOST}) refused; cause in $1 (429/quota or 403/opt-in)." > "${OUT}/BLOCKED"
  echo "BLOCKED ${RUN_ID}: quota proof refused, cause recorded in ${OUT}/BLOCKED"
  echo "PASS ${RUN_ID} ws=${WS} sid=${SID} BLOCKED quota-refused"
  exit 0
}
{
echo "### 0 key presence by length only (secret never enters artifacts)"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
echo "caller env carries no OPENCODE_API_KEY"
else
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
echo "### 1 workspace create on shared ${BASE} (no boot, no kills)"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"
echo "### 2 seed a tiny file the capped turn reads"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WS}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
echo "### 3 mint a session"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
F0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESS_JSON}")"
R0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESS_JSON}")"
echo "SID=${SID} F0=${F0} R0=${R0}"
echo "### 4 switch to ${KEYED_MODEL} plus thinking off (cheap, still keyed)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
${CLI} thinking --ws "${WS}" --sid "${SID}" --level off --base "${BASE}" --json || exit 1
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-before.json"
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/meta-before.json', 'utf8'));
if (b.model.provider !== 'opencode-go' || b.model.id !== 'deepseek-v4-flash') throw new Error('server cannot serve keyed turns (missing-secret plumbing): ' + JSON.stringify(b.model));
if (b.openRun !== null) throw new Error('session opens with a stuck run: ' + JSON.stringify(b.openRun));
console.log('keyed ok: triple opencode-go/deepseek-v4-flash, openRun null');
" || {
  printf '%s\n' "blocked: quota proof missing-secret plumbing (meta triple stayed stub; server key absent; cause in meta-before.json)." > "${OUT}/BLOCKED"
  echo "BLOCKED ${RUN_ID}: missing secret, transcript kept, exiting 0"
  echo "PASS ${RUN_ID} ws=${WS} sid=${SID} BLOCKED missing-secret"
  exit 0
}
echo "### 5 entries before the capped turn"
BEFORE_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${BEFORE_JSON}" > "${OUT}/entries-before.json"
BEFORE_COUNT="$(node -p "JSON.parse(process.argv[1]).entries.length" "${BEFORE_JSON}")"
echo "entries before=${BEFORE_COUNT}"
echo "### 6 write the node WS client (budgets ride the prompt frame)"
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const OUTFILE = process.env.OUTFILE;
const PROMPT = process.env.PROMPT || "read seed.txt";
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
const BUDGETS = process.env.BUDGETS ? JSON.parse(process.env.BUDGETS) : undefined;
import { writeFileSync } from "node:fs";
const frames = [];
let close = null;
let settled = false;
function save() {
  writeFileSync(OUTFILE, JSON.stringify({ frames, close }, null, 2) + "\n");
}
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2) + "\n");
  } catch {}
  process.exit(code);
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 120000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  const frame = { prompt: PROMPT };
  if (FENCE !== undefined) {
    frame.fence = FENCE;
    frame.expected = EXPECTED;
  }
  if (BUDGETS !== undefined) frame.budgets = BUDGETS;
  sock.send(JSON.stringify(frame));
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  save();
  if (frame.done === true) {
    try { sock.close(1000, "client done"); } catch {}
    setTimeout(() => finish(0, "done received"), 1000);
  } else if (frame.error !== undefined) {
    setTimeout(() => finish(3, "error frame: " + String(frame.error).slice(0, 200)), 1500);
  }
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  finish(0, null);
};
sock.onerror = () => {};
EOF
echo "client written"
echo "### 7 stream one capped keyed turn (maxCost ${MAXCOST} trips the cost halt)"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
STREAM1="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F0}&expected=${R0}"
CLIENT_CODE=0
WS_URL="${STREAM1}" PROMPT="${TINY_PROMPT}" FENCE="${F0}" EXPECTED="${R0}" BUDGETS="{\"maxCost\":${MAXCOST}}" OUTFILE="${OUT}/frames.json" node "${OUT}/ws-client.mjs" || CLIENT_CODE=$?
if [ "${CLIENT_CODE}" != "0" ] && [ "${CLIENT_CODE}" != "3" ]; then echo "client failed code=${CLIENT_CODE}; see ${OUT}/frames.json"; exit 1; fi
cat "${OUT}/frames.json"
echo "### 8 classify the turn: cost halt (green) versus refusal/missing-secret/cost-free (blocked)"
cat > "${OUT}/classify.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const OUT = process.env.OUT;
const b = JSON.parse(readFileSync(OUT + "/frames.json", "utf8"));
const blob = JSON.stringify(b);
const done = b.frames.find((f) => f.done === true);
const errFrame = b.frames.find((f) => f.error !== undefined);
let verdict;
if (done && done.halt && done.halt.reason === "cost") verdict = "cost-halt";
else if (/error[^}]{0,500}?(429|403|quota|rate.?limit|too many|overloaded|capacity|exceeded|insufficient|billing|datapolicy|opt.in|consent|unavailable)/i.test(blob)) verdict = "refused";
else if (/api.key|no key|auth|401|unauthorized/i.test(blob)) verdict = "missing-secret";
else if (done && !done.halt) {
  const c = done.usage && done.usage.costTotal;
  verdict = (typeof c === "number" && c > 0) ? "untripped" : "cost-free";
} else if (errFrame) verdict = "failed:" + String(errFrame.error).slice(0, 120);
else verdict = "incomplete";
writeFileSync(OUT + "/verdict.txt", verdict + "\n");
console.log("verdict: " + verdict);
EOF
OUT="${OUT}" node "${OUT}/classify.mjs" || exit 1
VERDICT="$(cat "${OUT}/verdict.txt")"
case "${VERDICT}" in
cost-halt) echo "credit refusal observed: done carries halt reason cost" ;;
refused) record_blocked "${OUT}/frames.json" "capped" ;;
missing-secret)
  printf '%s\n' "blocked: quota proof missing-secret plumbing (keyed turn unauthenticated; cause in frames.json)." > "${OUT}/BLOCKED"
  echo "BLOCKED ${RUN_ID}: missing secret, transcript kept, exiting 0"
  echo "PASS ${RUN_ID} ws=${WS} sid=${SID} BLOCKED missing-secret"
  exit 0 ;;
cost-free)
  printf '%s\n' "blocked: quota proof cost-free path (usage costTotal 0; maxCost cap untrippable this run; cause in frames.json)." > "${OUT}/BLOCKED"
  echo "BLOCKED ${RUN_ID}: cost-free path, transcript kept, exiting 0"
  echo "PASS ${RUN_ID} ws=${WS} sid=${SID} BLOCKED cost-free"
  exit 0 ;;
untripped) echo "cap untripped despite costTotal>0: the cost halt did not fire"; exit 1 ;;
*) echo "turn ended without refusal or completion: ${VERDICT}; see ${OUT}/frames.json"; exit 1 ;;
esac
echo "### 9 refusal shape: halt cost plus usage on the done frame, no error frames"
cat > "${OUT}/assert-refusal.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const OUT = process.env.OUT;
const R0 = Number(process.env.R0);
const MAXCOST = Number(process.env.MAXCOST);
const b = JSON.parse(readFileSync(OUT + "/frames.json", "utf8"));
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error("missing {done}");
if (!done.halt || done.halt.reason !== "cost") throw new Error("done.halt.reason must be cost: " + JSON.stringify(done.halt));
if (done.revision !== R0 + 1) throw new Error("done revision must be " + (R0 + 1) + ", got " + JSON.stringify(done.revision));
const u = done.usage;
for (const k of ["inTokens", "outTokens", "cacheRead", "costTotal", "elapsedMs"]) {
  if (typeof u[k] !== "number") throw new Error("usage." + k + " must be a number: " + JSON.stringify(u));
}
if (!(u.costTotal >= MAXCOST)) throw new Error("usage.costTotal must trip the maxCost cap: " + JSON.stringify(u));
if (!done.runtime || done.runtime.provider !== "opencode-go") throw new Error("refused turn must still be keyed: " + JSON.stringify(done.runtime));
if (b.frames.some((f) => f.error !== undefined)) throw new Error("halted turn must carry no error frame");
if (typeof done.result !== "string") throw new Error("done must carry a (possibly partial) result");
console.log("refusal shape ok: halt cost, revision " + R0 + "->" + done.revision + ", costTotal=" + u.costTotal);
EOF
OUT="${OUT}" R0="${R0}" MAXCOST="${MAXCOST}" node "${OUT}/assert-refusal.mjs" || exit 1
echo "### 10 ledger hygiene: result-with-halt committed, cursors gapless, openRun null"
AFTER_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${AFTER_JSON}" > "${OUT}/entries-after.json"
META_AFTER_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_AFTER_JSON}" > "${OUT}/meta-after.json"
cat > "${OUT}/assert-ledger.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const OUT = process.env.OUT;
const BEFORE_COUNT = Number(process.env.BEFORE_COUNT);
const replay = JSON.parse(readFileSync(OUT + "/entries-after.json", "utf8"));
const meta = JSON.parse(readFileSync(OUT + "/meta-after.json", "utf8"));
const entries = replay.entries;
if (entries.length === 0) throw new Error("no entries stored");
if (entries[0].cursor !== 1) throw new Error("chain must start at cursor 1, got " + entries[0].cursor);
for (let i = 1; i < entries.length; i++) {
  if (entries[i].cursor !== entries[i - 1].cursor + 1) throw new Error("cursor gap at index " + i);
}
const fresh = entries.slice(BEFORE_COUNT);
if (fresh.length === 0) throw new Error("refused turn wrote no entry rows");
if (fresh[0].type !== "prompt") throw new Error("refused turn must open with a prompt row, got " + fresh[0].type);
const results = fresh.filter((e) => e.type === "result");
if (results.length !== 1) throw new Error("refused turn must commit exactly one result, got " + results.length);
const rbody = JSON.parse(results[0].body);
if (!rbody.halt || rbody.halt.reason !== "cost") throw new Error("stored result must carry halt cost: " + JSON.stringify(rbody.halt));
if (typeof rbody.usage.costTotal !== "number") throw new Error("stored result must carry usage");
if (fresh.some((e) => e.type === "error" || e.type === "interrupted")) throw new Error("halted turn must leave no error/interrupted rows");
if (meta.openRun !== null) throw new Error("refused turn left a stuck open run: " + JSON.stringify(meta.openRun));
if (meta.count !== entries.length) throw new Error("meta count " + meta.count + " disagrees with entries " + entries.length);
console.log("ledger ok: " + fresh.length + " fresh rows (prompt..result-with-halt), cursors 1.." + entries.length + " gapless, openRun null");
EOF
OUT="${OUT}" BEFORE_COUNT="${BEFORE_COUNT}" node "${OUT}/assert-ledger.mjs" || exit 1
echo "### 11 orphan-age quiet: one full scan window (75s past the 60s orphan age) must add no rows"
cp "${OUT}/entries-after.json" "${OUT}/entries-quiet-before.json"
cp "${OUT}/meta-after.json" "${OUT}/meta-quiet-before.json"
sleep 75
QUIET_ENTRIES="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${QUIET_ENTRIES}" > "${OUT}/entries-quiet-after.json"
QUIET_META="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${QUIET_META}" > "${OUT}/meta-quiet-after.json"
node -e "
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync('${OUT}/entries-quiet-before.json', 'utf8')).entries;
const after = JSON.parse(fs.readFileSync('${OUT}/entries-quiet-after.json', 'utf8')).entries;
if (after.length !== before.length) throw new Error('scan window added rows: ' + before.length + ' -> ' + after.length);
for (let i = 0; i < after.length; i++) {
  if (after[i].cursor !== before[i].cursor || after[i].type !== before[i].type || after[i].body !== before[i].body) {
    throw new Error('scan window rewrote cursor ' + before[i].cursor);
  }
}
const mBefore = JSON.parse(fs.readFileSync('${OUT}/meta-quiet-before.json', 'utf8'));
const mAfter = JSON.parse(fs.readFileSync('${OUT}/meta-quiet-after.json', 'utf8'));
if (mAfter.openRun !== null) throw new Error('scan window left a stuck open run');
if (mAfter.count !== mBefore.count || mAfter.leaf !== mBefore.leaf) throw new Error('meta moved across a quiet window');
console.log('quiet ok: ' + after.length + ' rows unchanged across 75s, openRun null, count/leaf stable (no orphan redrive)');
" || exit 1
echo "### 12 follow-up capped turn completes on the next revision (chain healthy after refusal)"
F1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames.json','utf8')).frames.find((f)=>f.done===true).fence")"
R1="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/frames.json','utf8')).frames.find((f)=>f.done===true).revision")"
echo "F1=${F1} R1=${R1}"
STREAM2="${WS_BASE}/workspaces/${WS}/sessions/${SID}/stream?fence=${F1}&expected=${R1}"
CLIENT2_CODE=0
WS_URL="${STREAM2}" PROMPT="${TINY_PROMPT}" FENCE="${F1}" EXPECTED="${R1}" BUDGETS="{\"maxCost\":${MAXCOST}}" OUTFILE="${OUT}/frames2.json" node "${OUT}/ws-client.mjs" || CLIENT2_CODE=$?
if [ "${CLIENT2_CODE}" != "0" ] && [ "${CLIENT2_CODE}" != "3" ]; then echo "follow-up client failed code=${CLIENT2_CODE}"; exit 1; fi
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/frames2.json', 'utf8'));
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error('follow-up turn missing {done}: ' + JSON.stringify(b).slice(0, 300));
if (!done.halt || done.halt.reason !== 'cost') throw new Error('follow-up must halt on cost too: ' + JSON.stringify(done.halt));
if (done.revision !== (${R1} + 1)) throw new Error('follow-up revision must be ' + (${R1} + 1) + ', got ' + done.revision);
console.log('follow-up ok: halt cost, revision ${R1}->' + done.revision);
" || exit 1
FINAL_JSON="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json)" || exit 1
printf '%s' "${FINAL_JSON}" > "${OUT}/entries-final.json"
node -e "
const fs = require('node:fs');
const entries = JSON.parse(fs.readFileSync('${OUT}/entries-final.json', 'utf8')).entries;
for (let i = 1; i < entries.length; i++) {
  if (entries[i].cursor !== entries[i - 1].cursor + 1) throw new Error('final cursor gap at index ' + i);
}
const results = entries.filter((e) => e.type === 'result');
if (results.length !== 2) throw new Error('expected two halted results, got ' + results.length);
for (const r of results) {
  if (JSON.parse(r.body).halt.reason !== 'cost') throw new Error('final result missing halt cost');
}
if (entries.some((e) => e.type === 'error' || e.type === 'interrupted')) throw new Error('error/interrupted rows leaked into the chain');
console.log('final ok: ' + entries.length + ' rows gapless, 2 halted results, no error rows');
" || exit 1
echo "### 13 redaction grep over the artifacts"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "redaction vacuous keyless: no secret in caller env, nothing could have leaked"
  printf '%s\n' "redaction: vacuous (no OPENCODE_API_KEY in caller env)." > "${OUT}/redaction.txt"
else
  prefix="$(printf '%s' "${OPENCODE_API_KEY}" | cut -c1-16)"
  if grep -rF -q -- "${prefix}" "${OUT}"; then
    echo "key material leaked into ${OUT}"
    exit 1
  fi
  echo "redaction ok: key prefix absent from ${OUT}"
  printf '%s\n' "redaction: key prefix absent from ${OUT} (grep exit 1, no match)." > "${OUT}/redaction.txt"
fi
echo "PASS ${RUN_ID} ws=${WS} sid=${SID} quota-refused halt-cost no-orphans"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
