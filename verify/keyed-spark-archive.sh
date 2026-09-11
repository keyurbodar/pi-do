#!/bin/sh
# keyed-spark-archive.sh — proves stacked keyed compactions plus the compacted follow-up on opencode-go/muse-spark-1.3-contributor over the real server.
# Eight keyed turns with varied thinking plus instant thinking toggles fill the ledger past the force floor; then the manual floor plus the alarm-path manual stack two compactions (same runCompaction code path). The live replay holds the latest summary, the archive pages re-read the compacted prefix, the context build opens with the latest summary and projects the tail verbatim, the tail stays byte-stable across storage re-reads, and keyed turns before and after resolve from the compacted path (runtime.thinking reflected, result non-empty, usage positive).
# Keyed env needed: with no BASE the script boots its own wrangler dev on an isolated port with a temp single-line worker/.dev.vars carrying OPENCODE_API_KEY from the caller env (byte-identical to keyed-live.sh); with BASE it reuses that server and never writes a secret file. The secret never enters any artifact (redaction grep at the end proves it).
# Usage: sh verify/keyed-spark-archive.sh [BASE]
# Exit 0 on pass, 2 on blocked (OUT/BLOCKED names the stuck turn; never PASS); 1 otherwise. Writes artifacts/RUN_ID/keyed-spark-archive/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/keyed-spark-archive"
mkdir -p "${OUT}"
KEYED_PROVIDER="opencode-go"
KEYED_MODEL="muse-spark-1.3-contributor"
DEV_VARS="worker/.dev.vars"
CREATED=0
OWN=0
CUR=""
TURNS=0
if [ -z "${BASE}" ]; then OWN=1; fi
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi; if [ "${CREATED}" = "1" ]; then rm -f worker/.dev.vars; fi' EXIT INT TERM
is_quota() {
  grep -qiE "datapolicy|opt[.-]in|consent|quota|rate.limit|overloaded|capacity|(^|[^0-9a-fA-F])(429|403)([^0-9a-fA-F]|$)" "$1" "$2" 2>/dev/null
}
do_turn() {
  PROMPT="$1"
  TOKEN="$2"
  F="$3"
  printf '%s' "${PROMPT}" > "${OUT}/${F}.prompt"
  if ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${PROMPT}" --base "${BASE}" --json > "${OUT}/${F}.json" 2> "${OUT}/${F}.stderr"; then
    cat "${OUT}/${F}.json"
    if node -e "const b = JSON.parse(require('node:fs').readFileSync('${OUT}/${F}.json', 'utf8')); if (b.runtime && b.runtime.provider === 'stub') process.exit(0); process.exit(1);"; then
      printf '%s\n' "blocked: ${F} stayed on the stub path; the Worker never saw the key (missing-secret plumbing)." > "${OUT}/BLOCKED"
      echo "BLOCKED ${RUN_ID}: ${F} stayed stub, cause recorded in ${OUT}/BLOCKED"
      exit 2
    fi
    TOKEN="${TOKEN}" CUR="${CUR}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/${F}.json', 'utf8'));
if (!b.runtime || b.runtime.provider !== '${KEYED_PROVIDER}' || b.runtime.model !== '${KEYED_MODEL}') throw new Error('turn did not run keyed spark, got ' + JSON.stringify(b.runtime));
if (b.runtime.via !== 'createAgentSession') throw new Error('turn missed the factory: ' + JSON.stringify(b.runtime));
if (b.runtime.thinking !== process.env.CUR) throw new Error('turn thinking ' + b.runtime.thinking + ' want ' + process.env.CUR);
const u = b.usage;
if (!u || typeof u.inTokens !== 'number' || typeof u.outTokens !== 'number') throw new Error('usage missing: ' + JSON.stringify(u));
if (!(u.costTotal > 0)) throw new Error('expected nonzero costTotal, got ' + JSON.stringify(u));
if (b.toolCalls && b.toolCalls.length > 0) throw new Error('turn must stay tool-free, used ' + b.toolCalls.length + ' tools');
if (typeof b.result !== 'string' || b.result.length < 4) throw new Error('result too short to be a model reply for ' + process.env.TOKEN);
console.log('turn ok: keyed ${KEYED_MODEL} thinking=' + b.runtime.thinking + ' token=' + process.env.TOKEN);
console.log('usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
  " || {
    echo "token miss on ${F}; one retry with the same prompt"
    if ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "${PROMPT}" --base "${BASE}" --json > "${OUT}/${F}.json" 2> "${OUT}/${F}.stderr"; then
      cat "${OUT}/${F}.json"
      TOKEN="${TOKEN}" CUR="${CUR}" node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/${F}.json', 'utf8'));
if (typeof b.result !== 'string' || b.result.length < 4) throw new Error('retry result too short for ' + process.env.TOKEN);
console.log('retry ok: token=' + process.env.TOKEN);
" || exit 1
    else
      echo "retry turn ${F} failed"
      exit 1
    fi
  }
  else
    cat "${OUT}/${F}.json" "${OUT}/${F}.stderr" 2>/dev/null || true
    if is_quota "${OUT}/${F}.json" "${OUT}/${F}.stderr"; then
      echo "blocked: quota/refusal on ${F} (prompt token ${TOKEN}); transcript kept"
      printf '%s\n' "blocked: ${F} (prompt token ${TOKEN}, thinking ${CUR}) refused (429/quota or 403/opt-in; cause in ${F}.json/${F}.stderr)." > "${OUT}/BLOCKED"
      echo "BLOCKED ${RUN_ID} ws=${WS} sid=${SID} quota-refusal"
      exit 2
    else
      echo "keyed turn ${F} failed without a 429/refusal signal"
      exit 1
    fi
  fi
}
{
echo "### 0 key presence by length only"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "caller env carries no OPENCODE_API_KEY"
else
  echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
if [ "${OWN}" = "1" ]; then
  if [ -z "${OPENCODE_API_KEY:-}" ]; then
    printf '%s\n' "blocked: own boot needs OPENCODE_API_KEY in the caller env; no keyed server can start." > "${OUT}/BLOCKED"
    echo "BLOCKED ${RUN_ID}: missing secret for own boot, cause recorded in ${OUT}/BLOCKED"
    exit 2
  fi
  if [ -e "${DEV_VARS}" ]; then
    printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${OUT}/dev-vars.expect"
    if cmp -s "${OUT}/dev-vars.expect" "${DEV_VARS}"; then
      echo "reusing identical ${DEV_VARS} without ownership"
    else
      echo "refusing to clobber existing ${DEV_VARS}; pass BASE or remove it"
      exit 1
    fi
    rm -f "${OUT}/dev-vars.expect"
  else
    printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${DEV_VARS}"
    CREATED=1
    echo "temp secret file written (length-only from here)"
  fi
  PORT=""
  for P in 8792 8791 8795 8796 8793 8794; do
    if curl -sf --max-time 2 "http://127.0.0.1:${P}/" >/dev/null 2>&1; then
      echo "port ${P} busy, trying next"
    else
      PORT="${P}"
      break
    fi
  done
  if [ -z "${PORT}" ]; then echo "no free isolated port 8791-8796"; exit 1; fi
  BASE="http://127.0.0.1:${PORT}"
  echo "start wrangler dev on isolated port ${PORT}"
  (cd worker && exec npx wrangler dev --port "${PORT}" --persist-to "${OUT}/persist" > "${OUT}/wrangler.log" 2>&1) &
  echo "$!" > "${OUT}/wrangler.pid"
  I=0
  while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
    I=$((I + 1))
    if [ "${I}" -ge 90 ]; then echo "wrangler dev never came up; see ${OUT}/wrangler.log"; exit 1; fi
    sleep 2
  done
  echo "dev up at ${BASE} pid=$(cat "${OUT}/wrangler.pid")"
else
  echo "reusing BASE ${BASE}; the caller must have given that server the secret"
fi

echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "${WS_JSON}" > "${OUT}/workspace.json"

echo "### 2 mint a session (triple starts null)"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
printf '%s' "${SESS_JSON}" > "${OUT}/session.json"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/session.json', 'utf8'));
if (b.model.provider !== null || b.model.id !== null) throw new Error('fresh triple must be null, got ' + JSON.stringify(b.model));
if (b.thinking !== null) throw new Error('fresh thinking must be null, got ' + JSON.stringify(b.thinking));
console.log('fresh triple ok: null/null/null');
" || exit 1

echo "### 3 model switch to ${KEYED_PROVIDER}/${KEYED_MODEL} (stored, second view)"
SWITCH_JSON="$(${CLI} model --ws "${WS}" --sid "${SID}" --model "${KEYED_PROVIDER}/${KEYED_MODEL}" --base "${BASE}" --json)" || exit 1
echo "${SWITCH_JSON}"
printf '%s' "${SWITCH_JSON}" > "${OUT}/switch.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/switch.json', 'utf8'));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('switch did not echo the triple: ' + JSON.stringify(b.model));
console.log('switch ok: ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1
META_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${META_JSON}" > "${OUT}/meta-after-model.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-model.json', 'utf8'));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('row triple wrong: ' + JSON.stringify(b.model));
console.log('row ok: meta re-read shows ${KEYED_PROVIDER}/${KEYED_MODEL}');
" || exit 1
echo "### 4 four tool-free keyed turns, thinking varied, then instant thinking toggles top the ledger past the force floor"
I=1
CUR=""
while [ "${I}" -le 4 ]; do
  LV=""
  case "${I}" in
    1) LV="low" ;;
    3) LV="high" ;;
  esac
  if [ -n "${LV}" ]; then
    THINK_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level "${LV}" --base "${BASE}" --json)" || exit 1
    printf '%s' "${THINK_JSON}" > "${OUT}/thinking-seed-${I}.json"
    node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking-seed-${I}.json', 'utf8'));
if (b.thinking !== '${LV}') throw new Error('seed switch wrong: ' + JSON.stringify(b));
console.log('seed thinking ok: ${LV}');
" || exit 1
    CUR="${LV}"
  fi
  N="$(printf '%02d' "${I}")"
  do_turn "Reply with exactly one short sentence about a lighthouse keeper. Do not call any tools. Turn ${N}" "arc-${N}" "turn-${N}"
  I=$((I + 1))
done
TOG=0
while [ "${TOG}" -lt 30 ]; do
  LIVE="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).entries.length")"
  if [ "${LIVE}" -gt 26 ]; then echo "ledger topped: live=${LIVE} after ${TOG} toggles"; break; fi
  if [ "${CUR}" = "high" ]; then LV2="low"; else LV2="high"; fi
  ${CLI} thinking --ws "${WS}" --sid "${SID}" --level "${LV2}" --base "${BASE}" --json > /dev/null || exit 1
  CUR="${LV2}"
  TOG=$((TOG + 1))
done
LIVE="$(${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).entries.length")"
if [ "${LIVE}" -le 26 ]; then echo "ledger never topped 26, live=${LIVE}"; exit 1; fi
echo "flooring with the manual compact (force path, same runCompaction the alarm runs; the alarm itself is proven keyless)"
${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/compact-floor.json" || exit 1
cat "${OUT}/compact-floor.json"
node -e "
const c = require('${OUT}/compact-floor.json');
if (!c.compacted) throw new Error('manual floor compact must fire on 27+ live entries');
console.log('floor ok: archived ' + c.archived + ' live ' + c.live + ' summary ' + c.summaryCursor);
" || exit 1
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-poll.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-poll2.json" || exit 1
echo "### 5 first compaction: live bounded, summaries present, tail contiguous, archive holds the prefix"
cp "${OUT}/entries-poll.json" "${OUT}/entries-first.json"
cp "${OUT}/meta-poll2.json" "${OUT}/meta-first.json"
node -e "
const fs = require('node:fs');
const post = JSON.parse(fs.readFileSync('${OUT}/entries-first.json', 'utf8')).entries;
const meta = JSON.parse(fs.readFileSync('${OUT}/meta-first.json', 'utf8'));
if (post.length > 52) throw new Error('live table not bounded: ' + post.length);
const summaries = post.filter((e) => e.type === 'compaction');
if (summaries.length < 1) throw new Error('expected at least one live summary, got 0');
const cursors = post.map((e) => e.cursor).slice().sort((a, b) => a - b);
for (let i = 1; i < cursors.length; i++) if (cursors[i] !== cursors[i - 1] + 1) throw new Error('live cursor gap between ' + cursors[i - 1] + ' and ' + cursors[i]);
const latest = summaries[summaries.length - 1];
const sbody = JSON.parse(latest.body);
console.log('settled ok: live=' + post.length + ' summaries=' + summaries.length + ' latest cursor=' + latest.cursor + ' range=' + sbody.fromCursor + '..' + sbody.toCursor + ' count=' + sbody.count);
console.log('archive total=' + meta.compaction.archiveTotal + ' pages=' + meta.compaction.archivePages + ' pending=' + meta.compaction.pending);
if (!(meta.compaction.archiveTotal > 0)) throw new Error('archive must hold the prefix');
" || exit 1
SUM1="$(node -p "const es=JSON.parse(require('node:fs').readFileSync('${OUT}/entries-first.json','utf8')).entries.filter((e)=>e.type==='compaction'); String(es[es.length-1].cursor)")"
echo "SUM1=${SUM1}"

echo "### 6 thinking switch mid-history (stored, model untouched)"
if [ "${CUR}" = "high" ]; then MID="low"; else MID="high"; fi
THINKM_JSON="$(${CLI} thinking --ws "${WS}" --sid "${SID}" --level "${MID}" --base "${BASE}" --json)" || exit 1
echo "${THINKM_JSON}"
printf '%s' "${THINKM_JSON}" > "${OUT}/thinking-mid.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/thinking-mid.json', 'utf8'));
if (b.requested !== '${MID}' || b.thinking !== '${MID}') throw new Error('mid switch not stored: ' + JSON.stringify(b));
console.log('mid thinking ok: ${MID} stored');
" || exit 1
CUR="${MID}"
METAM_JSON="$(${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json)" || exit 1
printf '%s' "${METAM_JSON}" > "${OUT}/meta-after-mid.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/meta-after-mid.json', 'utf8'));
if (b.thinking !== '${MID}') throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
if (b.model.provider !== '${KEYED_PROVIDER}' || b.model.id !== '${KEYED_MODEL}') throw new Error('model triple moved under mid switch: ' + JSON.stringify(b.model));
console.log('row ok: thinking=${MID}, model untouched');
" || exit 1

echo "### 7 one more keyed turn past the floor, then settle the alarm"
do_turn "Reply with exactly one short sentence about a lighthouse keeper. Do not call any tools. Turn mid" "arc-mid" "turn-mid"
TRIES=0
while [ "${TRIES}" -lt 25 ]; do
  ${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-settle-a.json" 2>/dev/null || exit 1
  ${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-settle-a.json" 2>/dev/null || exit 1
  sleep 4
  ${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-settle-b.json" 2>/dev/null || exit 1
  ${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-settle-b.json" 2>/dev/null || exit 1
  if node -e "
const fs = require('node:fs');
const a = fs.readFileSync('${OUT}/entries-settle-a.json', 'utf8');
const b = fs.readFileSync('${OUT}/entries-settle-b.json', 'utf8');
if (a !== b) process.exit(1);
const m = JSON.parse(fs.readFileSync('${OUT}/meta-settle-b.json', 'utf8'));
if (m.compaction.pending !== false) process.exit(1);
" 2>/dev/null; then
    echo "settled after ~$((TRIES * 4 + 4))s"
    break
  fi
  TRIES=$((TRIES + 1))
done
if [ "${TRIES}" -ge 25 ]; then echo "entries never settled"; exit 1; fi
cp "${OUT}/entries-settle-b.json" "${OUT}/entries-presettle.json"
cp "${OUT}/meta-settle-b.json" "${OUT}/meta-presettle.json"

echo "### 8 manual compact on the same path the alarm runs"
${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/manual.json" || exit 1
cat "${OUT}/manual.json"
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-second.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-second.json" || exit 1
node -e "
const fs = require('node:fs');
const t0 = JSON.parse(fs.readFileSync('${OUT}/meta-presettle.json', 'utf8')).compaction;
const t1 = JSON.parse(fs.readFileSync('${OUT}/meta-second.json', 'utf8')).compaction;
const first = JSON.parse(fs.readFileSync('${OUT}/meta-first.json', 'utf8')).compaction;
if (!(t1.archiveTotal > first.archiveTotal)) throw new Error('archive total must grow past the floor, got ' + first.archiveTotal + '->' + t1.archiveTotal);
if (!(t1.archivePages >= t0.archivePages)) throw new Error('archive pages must not shrink, got ' + t0.archivePages + '->' + t1.archivePages);
const post = JSON.parse(fs.readFileSync('${OUT}/entries-second.json', 'utf8')).entries;
if (post.length > 50) throw new Error('live table not bounded: ' + post.length);
const summaries = post.filter((e) => e.type === 'compaction');
if (summaries.length < 1) throw new Error('expected at least one live summary, got 0');
const latest = summaries[summaries.length - 1];
const sbody = JSON.parse(latest.body);
if (!(latest.cursor > Number('${SUM1}'))) throw new Error('live summary cursor never advanced past ' + '${SUM1}');
console.log('second compaction ok: live ' + post.length + ' summaries=' + summaries.length + ' latest cursor=' + latest.cursor + ' range=' + sbody.fromCursor + '..' + sbody.toCursor + ' count=' + sbody.count);
console.log('archive total=' + t1.archiveTotal + ' pages=' + t1.archivePages);
" || exit 1

echo "### 9 compactions stacked: archive pages re-read hold the earlier summary"
PAGES="$(node -p "require('${OUT}/meta-second.json').compaction.archivePages")"
P=1
while [ "${P}" -le "${PAGES}" ]; do
  ${CLI} archive --ws "${WS}" --sid "${SID}" --page "${P}" --base "${BASE}" --json > "${OUT}/archive-p${P}.json" || exit 1
  P=$((P + 1))
done
node -e "
const fs = require('node:fs');
const pages = require('${OUT}/meta-second.json').compaction.archivePages;
let archived = [];
for (let p = 1; p <= pages; p++) archived.push(...JSON.parse(fs.readFileSync('${OUT}/archive-p' + p + '.json', 'utf8')).entries);
const live = JSON.parse(fs.readFileSync('${OUT}/entries-second.json', 'utf8')).entries;
const inArchive = archived.filter((e) => e.type === 'compaction');
const inLive = live.filter((e) => e.type === 'compaction');
const total = inArchive.length + inLive.length;
if (total < 2) throw new Error('expected >=2 compaction entries across live plus archive, got ' + total);
console.log('compactions=' + total + ' (live ' + inLive.length + ' cursor=' + inLive[0].cursor + ', archived ' + inArchive.length + ' cursors=' + inArchive.map((e) => e.cursor).join(',') + ')');
" || exit 1

echo "### 10 context build opens with the latest summary, tail verbatim"
export OUT
cat > "${OUT}/check.mjs" <<'EOF'
import fs from "node:fs";
import { buildSessionContextFromEntries } from "../../../packages/pi-cf/src/agent/context.ts";
const out = process.env.OUT;
const rows = JSON.parse(fs.readFileSync(`${out}/entries-second.json`, "utf8")).entries;
const leaf = JSON.parse(fs.readFileSync(`${out}/meta-second.json`, "utf8")).leaf;
const lastLive = rows.filter((r) => r.type !== "compaction").pop();
if (leaf !== lastLive.cursor) throw new Error("leaf " + leaf + " must equal the last non-compaction cursor, last live cursor is " + lastLive.cursor);
const at = rows.map((e, i) => (e.type === "compaction" ? i : -1)).filter((i) => i >= 0);
if (at.length < 1) throw new Error("live replay must hold at least the latest summary, got 0");
const ci = at[at.length - 1];
const latest = rows[ci];
console.log("chain ok: " + rows.length + " entries, latest summary cursor=" + latest.cursor);
const ctx = buildSessionContextFromEntries(rows, leaf);
const first = ctx.messages[0];
if (first.role !== "compactionSummary") throw new Error("first message must be the compaction summary, got " + first.role);
if (first.cursor !== latest.cursor) throw new Error("build must open with the latest summary cursor " + latest.cursor + ", got " + first.cursor);
const wantSummary = JSON.parse(latest.body).summary;
if (first.text !== wantSummary) throw new Error("build summary text differs from the stored summary body");
console.log("summary identity ok: cursor=" + first.cursor + " chars=" + first.text.length);
const prompts = new Set();
for (const f of fs.readdirSync(out)) {
  if (!f.endsWith(".prompt")) continue;
  prompts.add(fs.readFileSync(`${out}/${f}`, "utf8"));
}
const results = new Map();
for (const f of fs.readdirSync(out)) {
  if (!/^turn-.*\.json$/.test(f)) continue;
  try {
    const r = JSON.parse(fs.readFileSync(`${out}/${f}`, "utf8"));
    if (typeof r.result === "string") results.set(r.result, r.usage);
  } catch { continue; }
}
const tailRows = rows.slice(ci + 1);
let projected = 0;
for (const row of tailRows) {
  const body = JSON.parse(row.body);
  const msg = ctx.messages.find((m) => m.cursor === row.cursor);
  if (row.type === "prompt") {
    if (!msg || msg.role !== "user" || msg.text !== body.prompt) throw new Error("tail prompt cursor " + row.cursor + " must project verbatim");
    if (!prompts.has(body.prompt)) throw new Error("tail prompt cursor " + row.cursor + " matches no sent prompt");
    projected++;
  } else if (row.type === "result") {
    if (!msg || msg.role !== "assistant" || msg.text !== body.result) throw new Error("tail result cursor " + row.cursor + " must project verbatim");
    if (!results.has(body.result)) throw new Error("tail result cursor " + row.cursor + " matches no recorded turn result");
    projected++;
  } else if (row.type === "thinking_level_change" || row.type === "model_change") {
    continue;
  } else if (row.type === "toolCall") {
    if (!msg || msg.role !== "toolCall") throw new Error("tail toolCall cursor " + row.cursor + " must project");
    projected++;
  } else if (row.type === "toolResult") {
    if (!msg || msg.role !== "toolResult" || msg.text !== body.output) throw new Error("tail toolResult cursor " + row.cursor + " must project verbatim");
    projected++;
  } else {
    throw new Error("tail holds unexpected type " + row.type + " at cursor " + row.cursor);
  }
}
for (const s of ctx.skipped) {
  const row = rows.find((e) => e.cursor === s.cursor);
  if (row && (row.type === "prompt" || row.type === "result" || row.type === "compaction")) {
    throw new Error("tail " + row.type + " cursor " + s.cursor + " must never sit in skipped");
  }
}
for (let i = 2; i < ctx.messages.length; i++) {
  if (!(ctx.messages[i].cursor > ctx.messages[i - 1].cursor)) throw new Error("tail messages must run in cursor order");
}
if (projected < 1) console.log("tail empty: final compaction left the summary newest, nothing to project (byte-identity proven in 11b)");
else console.log("tail-verbatim ok: " + projected + " tail prompt/result/tool entries project verbatim in cursor order");
EOF
node "${OUT}/check.mjs" || exit 1

echo "### 11 follow-up keyed turn resolves from the compacted path"
do_turn "Reply with exactly one short sentence about a lighthouse keeper. Do not call any tools. Turn post" "arc-post" "turn-post"
node -e "
const b = JSON.parse(require('node:fs').readFileSync('${OUT}/turn-post.json', 'utf8'));
if (b.runtime.thinking !== '${CUR}') throw new Error('follow-up thinking ' + b.runtime.thinking + ' want stored ${CUR}');
const u = b.usage;
console.log('follow-up usage: in=' + u.inTokens + ' out=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' elapsedMs=' + u.elapsedMs);
console.log('follow-up ok: thinking=${CUR} reflected, result non-empty, usage positive');
" || exit 1
echo "### 11b pre-compaction tail window replays byte-identical through the compacted path"
WINDOW="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/entries-presettle.json','utf8')).entries.filter((e)=>e.type==='prompt'||e.type==='result').length")"
echo "projected tail window=${WINDOW}"
if [ "${WINDOW}" -le 0 ]; then echo "tail window empty: the vacuous projection recurred"; exit 1; fi
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-post.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-post.json" || exit 1
POSTPAGES="$(node -p "require('${OUT}/meta-post.json').compaction.archivePages")"
PP=1
while [ "${PP}" -le "${POSTPAGES}" ]; do
  ${CLI} archive --ws "${WS}" --sid "${SID}" --page "${PP}" --base "${BASE}" --json > "${OUT}/archive-post-p${PP}.json" || exit 1
  PP=$((PP + 1))
done
node -e "
const fs = require('node:fs');
const pre = JSON.parse(fs.readFileSync('${OUT}/entries-presettle.json', 'utf8')).entries;
const win = pre.filter((e) => e.type === 'prompt' || e.type === 'result');
if (win.length < 1) throw new Error('tail window empty: the vacuous projection recurred, not a pass');
const post = JSON.parse(fs.readFileSync('${OUT}/entries-post.json', 'utf8')).entries;
const pages = require('${OUT}/meta-post.json').compaction.archivePages;
let archived = [];
for (let p = 1; p <= pages; p++) archived.push(...JSON.parse(fs.readFileSync('${OUT}/archive-post-p' + p + '.json', 'utf8')).entries);
const union = new Map();
for (const e of post.concat(archived)) union.set(e.cursor, JSON.stringify(e));
let n = 0;
for (const e of win) {
  const g = union.get(e.cursor);
  if (!g || g !== JSON.stringify(e)) throw new Error('window entry not byte-identical through the compacted path at cursor ' + e.cursor);
  n++;
}
console.log('tail-window ok: ' + n + ' pre-compaction prompt/result bodies byte-identical through the compacted path (live plus archive)');
" || exit 1

echo "### 12 tail byte-stable across the follow-up (storage re-read)"
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/entries-final.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-final.json" || exit 1
node -e "
const fs = require('node:fs');
const before = JSON.parse(fs.readFileSync('${OUT}/entries-second.json', 'utf8')).entries;
const after = JSON.parse(fs.readFileSync('${OUT}/entries-final.json', 'utf8')).entries;
const byCursor = new Map(after.map((e) => [e.cursor, e]));
let n = 0;
for (const e of before) {
  const g = byCursor.get(e.cursor);
  if (!g || JSON.stringify(g) !== JSON.stringify(e)) throw new Error('tail entry not byte-stable at cursor ' + e.cursor);
  n++;
}
const leaf = require('${OUT}/meta-final.json').leaf;
if (leaf !== after[after.length - 1].cursor) throw new Error('leaf must equal the last cursor');
console.log('tail-verbatim ok: ' + n + '/' + n + ' pre-follow-up entries byte-identical on re-read, leaf=' + leaf);
" || exit 1

echo "### 13 session totals second view plus summed usage"
node -e "
const fs = require('node:fs');
let t = { in: 0, out: 0, cacheRead: 0, cost: 0, ms: 0 };
for (const f of fs.readdirSync('${OUT}')) {
  if (!/^turn-.*\.json$/.test(f)) continue;
  const b = JSON.parse(fs.readFileSync('${OUT}/' + f, 'utf8'));
  if (!b.usage) continue;
  t.in += b.usage.inTokens || 0; t.out += b.usage.outTokens || 0;
  t.cacheRead += b.usage.cacheRead || 0; t.cost += b.usage.costTotal || 0; t.ms += b.usage.elapsedMs || 0;
}
if (!(t.in > 0 && t.cost > 0)) throw new Error('summed usage must be positive: ' + JSON.stringify(t));
console.log('total usage: in=' + t.in + ' out=' + t.out + ' cacheRead=' + t.cacheRead + ' costTotal=' + t.cost + ' elapsedMs=' + t.ms);
const m = JSON.parse(fs.readFileSync('${OUT}/meta-final.json', 'utf8'));
if (!m.usage || !(m.usage.inTokens > 0) || !(m.usage.costTotal > 0)) throw new Error('meta rollup must stay nonzero: ' + JSON.stringify(m.usage));
console.log('rollup ok: meta usage in=' + m.usage.inTokens + ' costTotal=' + m.usage.costTotal);
" || exit 1

echo "### 14 redaction grep over the artifacts"
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

echo "PASS ${RUN_ID} ws=${WS} sid=${SID} turns=${TURNS}"
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
