#!/bin/sh
# keyed-live.sh — proves the keyed battery over the real server, POST /run plus WS stream.
# First a keyless shakeout on a self-booted server (stub turn proves the harness),
# then keyed: discover the free opencode-go slug live (prefer mimo-v2.5), switch a
# session to it and prove (1) a factory keyed turn records runtime via/model/provider
# with positive usage, (2) a thinking switch to a level discovered from the switch
# echo is stored and reflected on the turn, (3) a keyed WS stream turn
# byte-matches storage on every entry frame with done usage quoted and runtime.model
# on the slug, (4) abort-then-next-prompt over WS marks interrupted and continues,
# (5) a WS turn plus a concurrent POST serialize on one chain with the second turn
# seeing first history, (6) a long-history session holds the MEM-06 reserve
# inTokens+maxTokens<=contextWindow with room quoted, (7) CACHE-01 stays SKIP with
# the source-grepped reason, (8) per-path usage/cost lines roll into a total that
# cross-checks the meta rollup, (9) a prefix-16 redaction grep proves the secret
# never entered the artifacts. Any 429/rate/quota stop writes a stop note, keeps
# green transcripts, skips the rest, still exits 0.
# Usage: sh verify/keyed-live.sh [BASE]. With no BASE the script boots its own
# wrangler dev pair (keyless shakeout, then keyed with a temp .dev.vars) on an
# isolated port and stops it on exit; with a BASE it reuses that server and never
# writes a secret file.
# Exit 0 on pass (or a named 429/missing-secret stop), 1 otherwise. Writes
# artifacts/RUN_ID/keyed-live/.
set -u
BASE="${1:-}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/keyed-live"
mkdir -p "${OUT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEED_BODY="seeded-body-${RUN_ID}"
SEED_PATH="seed.txt"
KEYED_PROVIDER="opencode-go"
DEV_VARS="worker/.dev.vars"
CREATED=0
OWN=0
STOP=0
FAILED_CODE=0
WS_BASE=""
PORT=""
S0="pending"; S1="pending"; S2="pending"; S3="pending"
S4="pending"; S5="pending"; S6="pending"; S7="pending"; S8="pending"
trap 'if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi; if [ "${CREATED}" = "1" ]; then rm -f worker/.dev.vars; fi' EXIT INT TERM
{
echo "### 0 key presence by length only"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
echo "caller env carries no OPENCODE_API_KEY"
else
echo "caller env carries OPENCODE_API_KEY length=${#OPENCODE_API_KEY}"
fi
if [ -z "${BASE}" ]; then OWN=1; fi

start_dev() {
PORT="8791"
while [ "${PORT}" -le 8800 ] && curl -sf --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; do
echo "port ${PORT} busy, trying next"
PORT=$((PORT + 1))
done
if [ "${PORT}" -gt 8800 ]; then echo "no free isolated port 8791-8800"; exit 1; fi
BASE="http://127.0.0.1:${PORT}"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
echo "start wrangler dev on isolated port ${PORT}"
(cd worker && exec npx wrangler dev --port "${PORT}" > "${OUT}/wrangler.log" 2>&1) &
echo "$!" > "${OUT}/wrangler.pid"
I=0
while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
I=$((I + 1))
if [ "${I}" -ge 90 ]; then echo "wrangler dev never came up; see ${OUT}/wrangler.log"; exit 1; fi
sleep 2
done
echo "dev up at ${BASE} pid=$(cat "${OUT}/wrangler.pid")"
}

kill_dev() {
if [ -f "${OUT}/wrangler.pid" ]; then kill "$(cat "${OUT}/wrangler.pid")" 2>/dev/null || true; fi
rm -f "${OUT}/wrangler.pid"
I=0
while curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
I=$((I + 1))
if [ "${I}" -ge 30 ]; then echo "old dev never released ${BASE}"; exit 1; fi
sleep 2
done
echo "dev down at ${BASE}"
}

note_stop() {
STOP=1
printf '%s\n' "STOP: $1" > "${OUT}/stop-note.txt"
echo "STOP: $1"
echo "remaining keyed steps skipped; green transcripts kept"
}

check_stop() {
F="$1"
C="$2"
if node -e "const fs=require('node:fs');let b;try{b=JSON.parse(fs.readFileSync('$F','utf8'))}catch(e){process.exit(1)};if(b&&typeof b.error==='string'&&/429|rate|quota/i.test(b.error)){process.exit(0)}process.exit(1);" 2>/dev/null; then
return 0
fi
if [ "${C}" != "0" ]; then
if grep -E -q "HTTP 429|status[^0-9]*429" "$F" "$F.stderr" 2>/dev/null; then
return 0
fi
fi
return 1
}

quote_path() {
node -e "const b=require('$1');const u=b.usage||{};console.log('$2 usage in='+(u.inTokens||0)+' out='+(u.outTokens||0)+' cacheRead='+(u.cacheRead||0)+' cost='+(u.costTotal||0)+' elapsed='+(u.elapsedMs||0)+'ms');const r=b.runtime||{};console.log('$2 runtime via='+(r.via||'?')+' model='+(r.provider||'?')+'/'+(r.model||'?')+' thinking='+(r.thinking===null?'null':(r.thinking||'?')));"
}

ledger_add() {
printf '%s %s\n' "$1" "$2" >> "${OUT}/ledger.txt"
touch "${OUT}/ledger.txt"
}

if [ "${OWN}" = "1" ]; then
echo "### 1 keyless shakeout: own server, no secret forwarded"
start_dev
WSK_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WSK_JSON}"
WSK="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WSK_JSON}")"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WSK}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
SESSK_JSON="$(${CLI} session create --ws "${WSK}" --base "${BASE}" --json)" || exit 1
SIDK="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESSK_JSON}")"
RUNK="$(${CLI} run --ws "${WSK}" --sid "${SIDK}" --prompt "Read ${SEED_PATH} and reply with its exact contents." --base "${BASE}" --json)" || exit 1
printf '%s' "${RUNK}" > "${OUT}/shakeout-run.json"
echo "${RUNK}"
SEED_BODY="${SEED_BODY}" node -e "
const b = require('${OUT}/shakeout-run.json');
if (b.runtime.model !== 'stub' || b.runtime.provider !== 'stub') throw new Error('shakeout must stay stub, got ' + JSON.stringify(b.runtime));
if (!String(b.result).includes(process.env.SEED_BODY)) throw new Error('shakeout result missing seeded read');
console.log('shakeout ok: stub/stub, seeded read returned, harness flows');
" || exit 1
S0="green"
kill_dev
else
echo "### 1 keyless shakeout on the reused BASE (records stub or keyed, asserts flow only)"
WS_BASE="$(printf '%s' "${BASE}" | sed 's/^http:/ws:/;s/^https:/wss:/')"
WSK_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WSK="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WSK_JSON}")"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WSK}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
SESSK_JSON="$(${CLI} session create --ws "${WSK}" --base "${BASE}" --json)" || exit 1
SIDK="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESSK_JSON}")"
RUNK="$(${CLI} run --ws "${WSK}" --sid "${SIDK}" --prompt "Read ${SEED_PATH} and reply with its exact contents." --base "${BASE}" --json)" || exit 1
printf '%s' "${RUNK}" > "${OUT}/shakeout-run.json"
echo "${RUNK}"
SEED_BODY="${SEED_BODY}" node -e "
const b = require('${OUT}/shakeout-run.json');
if (!String(b.result).includes(process.env.SEED_BODY)) throw new Error('shakeout result missing seeded read');
console.log('shakeout ok: flow runs, runtime ' + b.runtime.provider + '/' + b.runtime.model);
" || exit 1
S0="green"
fi

echo "### 2 keyed server plumbing"
if [ -z "${OPENCODE_API_KEY:-}" ]; then
note_stop "missing-secret plumbing: OPENCODE_API_KEY absent from caller env; keyed steps unreachable."
S1="blocked"; S2="blocked"; S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
if [ "${OWN}" = "1" ]; then
if [ -e "${DEV_VARS}" ]; then echo "refusing to clobber existing ${DEV_VARS}; pass BASE or remove it"; exit 1; fi
printf '%s=%s\n' "OPENCODE_API_KEY" "${OPENCODE_API_KEY}" > "${DEV_VARS}"
CREATED=1
echo "temp secret file written (length-only from here)"
start_dev
else
echo "reusing BASE; the caller must have given that server the secret"
fi
echo "### 3 keyed gate: an explicitly switched run must leave the stub"
WSG_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WSG="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WSG_JSON}")"
printf '%s' "${WSG_JSON}" > "${OUT}/gate-workspace.json"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WSG}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
SESSG_JSON="$(${CLI} session create --ws "${WSG}" --base "${BASE}" --json)" || exit 1
SIDG="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESSG_JSON}")"
${CLI} models --provider "${KEYED_PROVIDER}" --base "${BASE}" --json > "${OUT}/gate-models.json" || exit 1
GATE_SLUG="$(node -p "const b=JSON.parse(require('fs').readFileSync('${OUT}/gate-models.json','utf8'));const ids=(b.models||[]).map((m)=>m.id);(ids.filter((id)=>String(id).includes('mimo-v2.5')).sort()[0]||ids.filter((id)=>String(id).includes('mimo')).sort()[0]||ids.sort()[0]||'')")" || exit 1
if [ -z "${GATE_SLUG}" ]; then echo "gate failed: empty models slice"; exit 1; fi
${CLI} model --ws "${WSG}" --sid "${SIDG}" --model "${KEYED_PROVIDER}/${GATE_SLUG}" --base "${BASE}" --json > "${OUT}/gate-switch.json" || exit 1
CODE=0
${CLI} run --ws "${WSG}" --sid "${SIDG}" --prompt "Read ${SEED_PATH} and reply with its exact contents." --base "${BASE}" --json > "${OUT}/gate-run.json" 2> "${OUT}/gate-run.stderr" || CODE=$?
cat "${OUT}/gate-run.json"
if check_stop "${OUT}/gate-run.json" "${CODE}"; then
note_stop "keyed gate hit 429/rate/quota; secret plumbing ok, provider throttled."
S1="blocked"; S2="blocked"; S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
if [ "${CODE}" != "0" ]; then echo "keyed gate failed on code"; cat "${OUT}/gate-run.stderr"; exit 1; fi
GATE_MODEL="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/gate-run.json','utf8')).runtime.model")" || exit 1
if [ "${GATE_MODEL}" = "stub" ]; then
note_stop "missing-secret plumbing: switched run stayed on the stub, the Worker never saw the key."
S1="blocked"; S2="blocked"; S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
node -e "
const b = require('${OUT}/gate-run.json');
console.log('gate ok: keyed via=' + b.runtime.via + ' model=' + b.runtime.provider + '/' + b.runtime.model);
" || exit 1
fi
if [ "${STOP}" = "0" ]; then
quote_path "${OUT}/gate-run.json" "gate"
ledger_add "${SIDG}" "${OUT}/gate-run.json"
fi
fi
fi

if [ "${STOP}" = "0" ]; then
echo "### 4 free slug discovered live, mimo-v2.5 preferred"
${CLI} models --provider "${KEYED_PROVIDER}" --base "${BASE}" --json > "${OUT}/models-slice.json" 2> "${OUT}/models-slice.stderr" || { echo "models slice failed"; cat "${OUT}/models-slice.stderr"; exit 1; }
cat "${OUT}/models-slice.json"
node -e "
const b = require('${OUT}/models-slice.json');
const ids = (b.models || []).map((m) => m.id);
let pick = ids.filter((id) => String(id).includes('mimo-v2.5')).sort()[0] || ids.filter((id) => String(id).includes('mimo')).sort()[0];
if (!pick) throw new Error('fail closed: no mimo slug in the ${KEYED_PROVIDER} slice: ' + JSON.stringify(ids));
const hit = b.models.find((m) => m.id === pick);
if (typeof hit.contextWindow !== 'number' || typeof hit.maxTokens !== 'number') throw new Error('slice entry lacks C/M: ' + JSON.stringify(hit));
require('node:fs').writeFileSync('${OUT}/slug.txt', '${KEYED_PROVIDER}' + '\n' + pick + '\n' + hit.contextWindow + '\n' + hit.maxTokens + '\n');
console.log('slug ok: ${KEYED_PROVIDER}/' + pick + ' C=' + hit.contextWindow + ' M=' + hit.maxTokens);
" || exit 1
SLUG="$(sed -n '2p' "${OUT}/slug.txt")"
CTXW="$(sed -n '3p' "${OUT}/slug.txt")"
MAXT="$(sed -n '4p' "${OUT}/slug.txt")"
echo "SLUG=${KEYED_PROVIDER}/${SLUG} C=${CTXW} M=${MAXT}"
fi

if [ "${STOP}" = "0" ]; then
echo "### 5 proof 1: factory keyed turn records the switched triple"
WSA_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WSA="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WSA_JSON}")"
printf '%s' "${WSA_JSON}" > "${OUT}/p1-workspace.json"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WSA}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
SESSA_JSON="$(${CLI} session create --ws "${WSA}" --base "${BASE}" --json)" || exit 1
SIDA="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESSA_JSON}")"
echo "SIDA=${SIDA}"
CODE=0
${CLI} model --ws "${WSA}" --sid "${SIDA}" --model "${KEYED_PROVIDER}/${SLUG}" --base "${BASE}" --json > "${OUT}/p1-switch.json" 2> "${OUT}/p1-switch.stderr" || CODE=$?
cat "${OUT}/p1-switch.json"
if check_stop "${OUT}/p1-switch.json" "${CODE}"; then
note_stop "proof 1 switch hit 429/rate/quota."
S1="blocked"; S2="blocked"; S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 1 switch failed on code"; cat "${OUT}/p1-switch.stderr"; exit 1; }
CODE=0
${CLI} run --ws "${WSA}" --sid "${SIDA}" --prompt "Read ${SEED_PATH} and reply with its exact contents." --base "${BASE}" --json > "${OUT}/p1-run.json" 2> "${OUT}/p1-run.stderr" || CODE=$?
cat "${OUT}/p1-run.json"
if check_stop "${OUT}/p1-run.json" "${CODE}"; then
note_stop "proof 1 turn hit 429/rate/quota."
S1="blocked"; S2="blocked"; S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 1 turn failed on code"; cat "${OUT}/p1-run.stderr"; exit 1; }
KEYED_PROVIDER="${KEYED_PROVIDER}" SLUG="${SLUG}" SEED_BODY="${SEED_BODY}" node -e "
const b = require('${OUT}/p1-run.json');
if (b.runtime.via !== 'createAgentSession') throw new Error('via, got ' + JSON.stringify(b.runtime));
if (b.runtime.model !== process.env.SLUG || b.runtime.provider !== process.env.KEYED_PROVIDER) throw new Error('triple, got ' + JSON.stringify(b.runtime));
if (!(b.usage.inTokens > 0 && b.usage.outTokens > 0)) throw new Error('usage must be positive, got ' + JSON.stringify(b.usage));
if (!String(b.result).includes(process.env.SEED_BODY)) throw new Error('result missing seeded read');
console.log('factory ok: keyed turn recorded the slug with positive usage');
" || exit 1
quote_path "${OUT}/p1-run.json" "p1"
ledger_add "${SIDA}" "${OUT}/p1-run.json"
S1="green"
fi
fi
else
echo "SKIP proof 1 (stopped)"
fi

if [ "${STOP}" = "0" ]; then
echo "### 6 proof 2: thinking level discovered from the switch echo, stored, reflected"
CODE=0
${CLI} thinking --ws "${WSA}" --sid "${SIDA}" --level high --base "${BASE}" --json > "${OUT}/p2-thinking.json" 2> "${OUT}/p2-thinking.stderr" || CODE=$?
cat "${OUT}/p2-thinking.json"
if check_stop "${OUT}/p2-thinking.json" "${CODE}"; then
note_stop "proof 2 switch hit 429/rate/quota."
S2="blocked"; S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 2 switch failed on code"; cat "${OUT}/p2-thinking.stderr"; exit 1; }
LEVEL="$(node -p "JSON.parse(require('node:fs').readFileSync('${OUT}/p2-thinking.json','utf8')).thinking")"
echo "LEVEL=${LEVEL} (applied after clamp, never assumed)"
${CLI} meta --ws "${WSA}" --sid "${SIDA}" --base "${BASE}" --json > "${OUT}/p2-meta.json" || exit 1
LEVEL="${LEVEL}" node -e "
const b = require('${OUT}/p2-meta.json');
if (b.thinking !== process.env.LEVEL) throw new Error('row thinking wrong: ' + JSON.stringify(b.thinking));
console.log('stored ok: meta re-read shows thinking=' + b.thinking);
" || exit 1
CODE=0
${CLI} run --ws "${WSA}" --sid "${SIDA}" --prompt "Read ${SEED_PATH} again and reply with its exact contents." --base "${BASE}" --json > "${OUT}/p2-run.json" 2> "${OUT}/p2-run.stderr" || CODE=$?
cat "${OUT}/p2-run.json"
if check_stop "${OUT}/p2-run.json" "${CODE}"; then
note_stop "proof 2 turn hit 429/rate/quota."
S2="blocked"; S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 2 turn failed on code"; cat "${OUT}/p2-run.stderr"; exit 1; }
LEVEL="${LEVEL}" SLUG="${SLUG}" node -e "
const b = require('${OUT}/p2-run.json');
if (b.runtime.thinking !== process.env.LEVEL) throw new Error('turn thinking not reflected: ' + JSON.stringify(b.runtime));
if (b.runtime.model !== process.env.SLUG) throw new Error('model moved: ' + JSON.stringify(b.runtime));
console.log('reflected ok: turn carries thinking=' + b.runtime.thinking + ' on the slug');
" || exit 1
quote_path "${OUT}/p2-run.json" "p2"
ledger_add "${SIDA}" "${OUT}/p2-run.json"
S2="green"
fi
fi
else
echo "SKIP proof 2 (stopped)"
fi

if [ "${STOP}" = "0" ]; then
echo "### 7 proof 3: keyed stream turn byte-matches storage with done usage quoted"
WSB_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WSB="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WSB_JSON}")"
printf '%s' "${WSB_JSON}" > "${OUT}/p3-workspace.json"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WSB}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
SESSB_JSON="$(${CLI} session create --ws "${WSB}" --base "${BASE}" --json)" || exit 1
printf '%s' "${SESSB_JSON}" > "${OUT}/p3-session.json"
SIDB="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESSB_JSON}")"
FB0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESSB_JSON}")"
RB0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESSB_JSON}")"
echo "SIDB=${SIDB}"
CODE=0
${CLI} model --ws "${WSB}" --sid "${SIDB}" --model "${KEYED_PROVIDER}/${SLUG}" --base "${BASE}" --json > "${OUT}/p3-switch.json" 2> "${OUT}/p3-switch.stderr" || CODE=$?
cat "${OUT}/p3-switch.json"
if check_stop "${OUT}/p3-switch.json" "${CODE}"; then
note_stop "proof 3 switch hit 429/rate/quota."
S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 3 switch failed on code"; cat "${OUT}/p3-switch.stderr"; exit 1; }
cat > "${OUT}/ws-client.mjs" <<'EOF'
const WS_URL = process.env.WS_URL;
const MODE = process.env.MODE || "turn";
const OUTFILE = process.env.OUTFILE;
const STOPFILE = process.env.STOPFILE || "";
const PROMPT = process.env.PROMPT || "read seed.txt";
const PROMPT2 = process.env.PROMPT2 || "read seed.txt again";
const FENCE = process.env.FENCE;
const EXPECTED = process.env.EXPECTED !== undefined ? Number(process.env.EXPECTED) : undefined;
import { writeFileSync } from "node:fs";
const frames = [];
let close = null;
let settled = false;
let abortSent = false;
let steerSent = false;
function stopHit(text) {
  return typeof text === "string" && /429|rate|quota/i.test(text);
}
function finish(code, note) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  writeFileSync(OUTFILE, JSON.stringify({ frames, close, note: note || null }, null, 2));
  process.exit(code);
}
function scanStop() {
  for (const f of frames) {
    if (f.error !== undefined && typeof f.error === "string" && stopHit(f.error)) {
      if (STOPFILE !== "") writeFileSync(STOPFILE, f.error.slice(0, 200));
      finish(3, "provider stop: " + f.error.slice(0, 120));
      return true;
    }
  }
  return false;
}
const timer = setTimeout(() => finish(1, "client timeout waiting for frames"), 120000);
const sock = new WebSocket(WS_URL);
sock.onopen = () => {
  const frame = { prompt: PROMPT };
  if (FENCE !== undefined) {
    frame.fence = FENCE;
    frame.expected = EXPECTED;
  }
  sock.send(JSON.stringify(frame));
};
sock.onmessage = (event) => {
  const frame = JSON.parse(String(event.data));
  frames.push(frame);
  if (scanStop()) return;
  if (MODE === "abort-next") {
    if (frame.entry && !abortSent) {
      abortSent = true;
      try {
        sock.send(JSON.stringify({ abort: true }));
      } catch {
      }
    }
    if (frame.aborted === true) {
      try {
        sock.send(JSON.stringify({ prompt: PROMPT2 }));
      } catch {
      }
    }
    if (frame.done === true) closeAndFinish();
  } else if (MODE === "steer-queue") {
    if (frame.entry && !steerSent) {
      steerSent = true;
      try {
        sock.send(JSON.stringify({ steer: true, text: "steer-note-keyed" }));
      } catch {
      }
    }
    if (frame.done === true) closeAndFinish();
  } else if (frame.done === true) {
    closeAndFinish();
  }
};
sock.onclose = (event) => {
  close = { code: event.code, reason: event.reason, wasClean: event.wasClean };
  if (scanStop()) return;
  finish(0, null);
};
sock.onerror = () => {
};
function closeAndFinish() {
  try {
    sock.close(1000, "client done");
  } catch {
  }
  setTimeout(() => finish(0, "done received; closed optimistically"), 1000);
};
EOF
echo "client written"
STREAMB="${WS_BASE}/workspaces/${WSB}/sessions/${SIDB}/stream?fence=${FB0}&expected=${RB0}"
CODE=0
WS_URL="${STREAMB}" MODE=turn PROMPT="Read ${SEED_PATH} and reply with its exact contents." FENCE="${FB0}" EXPECTED="${RB0}" OUTFILE="${OUT}/p3-frames.json" STOPFILE="${OUT}/.stopbus" node "${OUT}/ws-client.mjs" || CODE=$?
cat "${OUT}/p3-frames.json"
if [ -f "${OUT}/.stopbus" ]; then
note_stop "proof 3 stream hit $(cat "${OUT}/.stopbus")."
S3="blocked"; S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 3 stream failed on code"; exit 1; }
${CLI} entries --ws "${WSB}" --sid "${SIDB}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/p3-entries.json" || exit 1
${CLI} meta --ws "${WSB}" --sid "${SIDB}" --base "${BASE}" --json > "${OUT}/p3-meta.json" || exit 1
node -e "
const fs = require('node:fs');
const b = JSON.parse(fs.readFileSync('${OUT}/p3-frames.json', 'utf8'));
const replay = JSON.parse(fs.readFileSync('${OUT}/p3-entries.json', 'utf8'));
const byCursor = new Map(replay.entries.map((e) => [e.cursor, e]));
const entryFrames = b.frames.filter((f) => f.entry);
if (entryFrames.length === 0) throw new Error('no entry frames streamed');
for (const f of entryFrames) {
  const s = byCursor.get(f.entry.cursor);
  if (!s) throw new Error('streamed cursor ' + f.entry.cursor + ' missing from storage');
  if (s.type !== f.entry.type || s.body !== f.entry.body) throw new Error('byte mismatch at cursor ' + f.entry.cursor);
}
console.log('byte-compare ok: ' + entryFrames.length + ' entry frames match storage re-reads');
const done = b.frames.find((f) => f.done === true);
if (!done) throw new Error('missing {done}');
const u = done.usage || {};
console.log('p3 usage in=' + (u.inTokens || 0) + ' out=' + (u.outTokens || 0) + ' cacheRead=' + (u.cacheRead || 0) + ' cost=' + (u.costTotal || 0) + ' elapsed=' + (u.elapsedMs || 0) + 'ms');
if (!((u.inTokens || 0) > 0 && (u.outTokens || 0) > 0)) throw new Error('done usage must be positive on a keyed turn');
if (!done.runtime) { console.log('RUNTIME_GAP'); process.exit(7); }
const r = done.runtime;
console.log('p4 runtime via=' + r.via + ' model=' + r.provider + '/' + r.model + ' thinking=' + r.thinking);
if (r.model !== '${SLUG}' || r.provider !== '${KEYED_PROVIDER}') throw new Error('done runtime off the slug: ' + JSON.stringify(r));
if (r.via !== 'createAgentSession') throw new Error('done via wrong: ' + JSON.stringify(r));
" || CODE=$?
if [ "${CODE}" = "7" ]; then
echo "proof 3 stream ran keyed with byte-exact frames, but the done frame carries no runtime (StreamTripleFix declined without a Main amendment); recorded failed-on-code, continuing"
FAILED_CODE=1
S3="failed-on-code"
node -e "
const done = require('${OUT}/p3-frames.json').frames.find((f) => f.done === true);
require('node:fs').writeFileSync('${OUT}/p3-done-usage.json', JSON.stringify({ sid: '${SIDB}', usage: done.usage }) + '\n');
"
ledger_add "${SIDB}" "${OUT}/p3-done-usage.json"
else
[ "${CODE}" = "0" ] || exit 1
node -e "
const done = require('${OUT}/p3-frames.json').frames.find((f) => f.done === true);
require('node:fs').writeFileSync('${OUT}/p3-done-usage.json', JSON.stringify({ sid: '${SIDB}', usage: done.usage }) + '\n');
"
ledger_add "${SIDB}" "${OUT}/p3-done-usage.json"
S3="green"
fi
fi
fi
else
echo "SKIP proof 3 (stopped)"
fi

if [ "${STOP}" = "0" ]; then
echo "### 8 proof 4: abort-then-next-prompt over WS marks interrupted and continues"
WSC_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WSC="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WSC_JSON}")"
printf '%s' "${WSC_JSON}" > "${OUT}/p4-workspace.json"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WSC}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
SESSC_JSON="$(${CLI} session create --ws "${WSC}" --base "${BASE}" --json)" || exit 1
SIDC="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESSC_JSON}")"
FC0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESSC_JSON}")"
RC0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESSC_JSON}")"
echo "SIDC=${SIDC}"
CODE=0
${CLI} model --ws "${WSC}" --sid "${SIDC}" --model "${KEYED_PROVIDER}/${SLUG}" --base "${BASE}" --json > "${OUT}/p4-switch.json" 2> "${OUT}/p4-switch.stderr" || CODE=$?
if check_stop "${OUT}/p4-switch.json" "${CODE}"; then
note_stop "proof 4 switch hit 429/rate/quota."
S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 4 switch failed on code"; cat "${OUT}/p4-switch.stderr"; exit 1; }
STREAMC="${WS_BASE}/workspaces/${WSC}/sessions/${SIDC}/stream?fence=${FC0}&expected=${RC0}"
rm -f "${OUT}/.stopbus"
CODE=0
WS_URL="${STREAMC}" MODE=abort-next PROMPT="Read ${SEED_PATH} and reply with its exact contents." PROMPT2="Read ${SEED_PATH} again and reply with its exact contents." FENCE="${FC0}" EXPECTED="${RC0}" OUTFILE="${OUT}/p4-frames.json" STOPFILE="${OUT}/.stopbus" node "${OUT}/ws-client.mjs" || CODE=$?
cat "${OUT}/p4-frames.json"
if [ -f "${OUT}/.stopbus" ]; then
note_stop "proof 4 stream hit $(cat "${OUT}/.stopbus")."
S4="blocked"; S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 4 stream failed on code"; exit 1; }
${CLI} entries --ws "${WSC}" --sid "${SIDC}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/p4-entries.json" || exit 1
${CLI} meta --ws "${WSC}" --sid "${SIDC}" --base "${BASE}" --json > "${OUT}/p4-meta.json" || exit 1
SEED_BODY="${SEED_BODY}" node -e "
const fs = require('node:fs');
const frames = JSON.parse(fs.readFileSync('${OUT}/p4-frames.json', 'utf8')).frames;
const aborted = frames.find((f) => f.aborted === true);
if (!aborted) throw new Error('missing {aborted} for the cancelled turn');
console.log('aborted ok: run ' + aborted.runId);
const done = frames.find((f) => f.done === true);
if (!done) throw new Error('missing {done} after the abort');
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('post-abort result missing seeded read');
const u = done.usage || {};
console.log('p4 usage in=' + (u.inTokens || 0) + ' out=' + (u.outTokens || 0) + ' cacheRead=' + (u.cacheRead || 0) + ' cost=' + (u.costTotal || 0) + ' elapsed=' + (u.elapsedMs || 0) + 'ms');
const entries = JSON.parse(fs.readFileSync('${OUT}/p4-entries.json', 'utf8')).entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
const hit = entries.find((e) => { if (e.type !== 'interrupted') return false; try { return JSON.parse(e.body).runId === aborted.runId; } catch { return false; } });
if (!hit) throw new Error('no interrupted entry for the aborted run ' + aborted.runId);
console.log('interrupted ok: prior run marked interrupted, next prompt continued cleanly');
const again = entries.find((e) => e.type === 'prompt' && e.body.includes('again'));
if (!again || again.cursor < hit.cursor) throw new Error('next prompt missing after the abort');
const meta = JSON.parse(fs.readFileSync('${OUT}/p4-meta.json', 'utf8'));
if (meta.openRun !== null) throw new Error('expected no open run, got ' + JSON.stringify(meta.openRun));
require('node:fs').writeFileSync('${OUT}/p4-done-usage.json', JSON.stringify({ sid: '${SIDC}', usage: done.usage }) + '\n');
" || exit 1
ledger_add "${SIDC}" "${OUT}/p4-done-usage.json"
S4="green"
fi
fi
else
echo "SKIP proof 4 (stopped)"
fi

if [ "${STOP}" = "0" ]; then
echo "### 9 proof 5: WS plus a concurrent POST serialize on one chain, second sees first history"
WSD_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WSD="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WSD_JSON}")"
printf '%s' "${WSD_JSON}" > "${OUT}/p5-workspace.json"
printf '%s' "${SEED_BODY}" | ${CLI} files put --ws "${WSD}" --path "${SEED_PATH}" --base "${BASE}" --json || exit 1
SESSD_JSON="$(${CLI} session create --ws "${WSD}" --base "${BASE}" --json)" || exit 1
SIDD="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESSD_JSON}")"
FD0="$(node -p "JSON.parse(process.argv[1]).fence" "${SESSD_JSON}")"
RD0="$(node -p "JSON.parse(process.argv[1]).revision" "${SESSD_JSON}")"
echo "SIDD=${SIDD}"
CODE=0
${CLI} model --ws "${WSD}" --sid "${SIDD}" --model "${KEYED_PROVIDER}/${SLUG}" --base "${BASE}" --json > "${OUT}/p5-switch.json" 2> "${OUT}/p5-switch.stderr" || CODE=$?
if check_stop "${OUT}/p5-switch.json" "${CODE}"; then
note_stop "proof 5 switch hit 429/rate/quota."
S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 5 switch failed on code"; cat "${OUT}/p5-switch.stderr"; exit 1; }
STREAMD="${WS_BASE}/workspaces/${WSD}/sessions/${SIDD}/stream?fence=${FD0}&expected=${RD0}"
rm -f "${OUT}/.stopbus"
WS_URL="${STREAMD}" MODE=steer-queue PROMPT="Read ${SEED_PATH} and reply with its exact contents." FENCE="${FD0}" EXPECTED="${RD0}" OUTFILE="${OUT}/p5-frames.json" STOPFILE="${OUT}/.stopbus" node "${OUT}/ws-client.mjs" &
PW=$!
sleep 3
CODE=0
${CLI} run --ws "${WSD}" --sid "${SIDD}" --prompt "Quote the exact seeded body the earlier turn in this session read from ${SEED_PATH}." --base "${BASE}" --json > "${OUT}/p5-post.json" 2> "${OUT}/p5-post.stderr" || CODE=$?
wait "${PW}"; CW=$?
echo "ws exit=${CW} post exit=${CODE}"
cat "${OUT}/p5-frames.json" "${OUT}/p5-post.json"
if [ -f "${OUT}/.stopbus" ]; then
note_stop "proof 5 stream hit $(cat "${OUT}/.stopbus")."
S5="blocked"; S6="blocked"; S7="blocked"
else
if check_stop "${OUT}/p5-post.json" "${CODE}"; then
note_stop "proof 5 POST hit 429/rate/quota."
S5="blocked"; S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 5 POST failed on code"; cat "${OUT}/p5-post.stderr"; exit 1; }
[ "${CW}" = "0" ] || { echo "proof 5 WS failed on code"; exit 1; }
${CLI} entries --ws "${WSD}" --sid "${SIDD}" --after 0 --limit 1000 --base "${BASE}" --json > "${OUT}/p5-entries.json" || exit 1
SEED_BODY="${SEED_BODY}" node -e "
const fs = require('node:fs');
const frames = JSON.parse(fs.readFileSync('${OUT}/p5-frames.json', 'utf8')).frames;
if (frames.some((f) => f.busy === true)) throw new Error('queued paths must serialize, never answer {busy:true}');
const done = frames.find((f) => f.done === true);
if (!done) throw new Error('WS turn missing {done}');
if (!String(done.result || '').includes(process.env.SEED_BODY)) throw new Error('WS result missing seeded read');
const steer = frames.find((f) => f.entry && f.entry.type === 'steer');
if (!steer || !String(steer.entry.body).includes('steer-note-keyed')) throw new Error('steer entry missing mid-turn');
console.log('serialize+steer ok: no busy, steer landed mid-turn, WS turn done');
const p = JSON.parse(fs.readFileSync('${OUT}/p5-post.json', 'utf8'));
if (!String(p.result || '').includes(process.env.SEED_BODY)) throw new Error('POST result misses history: the second turn did not see the first read');
console.log('history ok: queued POST quoted the earlier turn read');
const entries = JSON.parse(fs.readFileSync('${OUT}/p5-entries.json', 'utf8')).entries;
const cursors = entries.map((e) => e.cursor);
for (let i = 1; i < cursors.length; i++) {
  if (cursors[i] !== cursors[i - 1] + 1) throw new Error('cursor gap at index ' + i);
}
const byRun = new Map();
for (const e of entries) {
  let b;
  try { b = JSON.parse(e.body); } catch { continue; }
  if (!b || typeof b.runId !== 'string') continue;
  if (!byRun.has(b.runId)) byRun.set(b.runId, []);
  byRun.get(b.runId).push(e.cursor);
}
const runOf = (needle) => {
  const hit = entries.find((e) => e.type === 'prompt' && String(e.body).includes(needle));
  if (!hit) throw new Error('prompt entry missing for ' + needle);
  return JSON.parse(hit.body).runId;
};
const wRun = runOf('reply with its exact contents.');
const pRun = runOf('Quote the exact seeded body');
if (wRun === pRun) throw new Error('WS turn and POST turn must be distinct runs');
if (Math.max(...byRun.get(wRun)) >= Math.min(...byRun.get(pRun))) throw new Error('paths interleaved across runs');
console.log('ordered ok: one chain, WS run precedes POST run, no interleave');
const u = done.usage || {};
console.log('p5-ws usage in=' + (u.inTokens || 0) + ' out=' + (u.outTokens || 0) + ' cacheRead=' + (u.cacheRead || 0) + ' cost=' + (u.costTotal || 0) + ' elapsed=' + (u.elapsedMs || 0) + 'ms');
require('node:fs').writeFileSync('${OUT}/p5-done-usage.json', JSON.stringify({ sid: '${SIDD}', usage: done.usage }) + '\n');
" || exit 1
quote_path "${OUT}/p5-post.json" "p5-post"
ledger_add "${SIDD}" "${OUT}/p5-done-usage.json"
ledger_add "${SIDD}" "${OUT}/p5-post.json"
S5="green"
fi
fi
fi
else
echo "SKIP proof 5 (stopped)"
fi

if [ "${STOP}" = "0" ]; then
echo "### 10 proof 6: MEM-06 reserve on the long-history session"
CODE=0
${CLI} run --ws "${WSA}" --sid "${SIDA}" --prompt "Read ${SEED_PATH} one last time and reply with its exact contents (reserve check)." --base "${BASE}" --json > "${OUT}/p6-run.json" 2> "${OUT}/p6-run.stderr" || CODE=$?
cat "${OUT}/p6-run.json"
if check_stop "${OUT}/p6-run.json" "${CODE}"; then
note_stop "proof 6 turn hit 429/rate/quota."
S6="blocked"; S7="blocked"
else
[ "${CODE}" = "0" ] || { echo "proof 6 turn failed on code"; cat "${OUT}/p6-run.stderr"; exit 1; }
quote_path "${OUT}/p6-run.json" "p6"
ledger_add "${SIDA}" "${OUT}/p6-run.json"
${CLI} meta --ws "${WSA}" --sid "${SIDA}" --base "${BASE}" --json > "${OUT}/p6-meta.json" || exit 1
CTXW="${CTXW}" MAXT="${MAXT}" node -e "
const m = require('${OUT}/p6-meta.json');
const C = Number(process.env.CTXW);
const M = Number(process.env.MAXT);
const u = m.usage || {};
const room = C - u.inTokens - M;
console.log('reserve C=' + C + ' M=' + M + ' inTokens=' + u.inTokens + ' outTokens=' + u.outTokens + ' cacheRead=' + u.cacheRead + ' costTotal=' + u.costTotal + ' room=' + room);
if (!(u.inTokens + M <= C)) throw new Error('reserve violated: inTokens+maxTokens exceeds contextWindow');
if (room < 0) throw new Error('no room left for one maxTokens reply');
console.log('reserve ok: long-history session still fits one maxTokens reply');
" || exit 1
S6="green"
fi
else
echo "SKIP proof 6 (stopped)"
fi

if [ "${STOP}" = "0" ]; then
echo "### 11 proof 7: CACHE-01 SKIP asserted by grepping the source, not by traffic"
CS_LINE="$(grep -n "completeSimple(" "${ROOT}/packages/pi-cf/src/session.ts" | head -1 | cut -d: -f1)"
[ -n "${CS_LINE}" ] || { echo "completeSimple call site gone; re-examine the cache path"; exit 1; }
FROM=$((CS_LINE - 30))
TO=$((CS_LINE + 12))
echo "completeSimple call site at session.ts:${CS_LINE}; scanning lines ${FROM}-${TO} for a session id"
sed -n "${FROM},${TO}p" "${ROOT}/packages/pi-cf/src/session.ts"
if sed -n "${FROM},${TO}p" "${ROOT}/packages/pi-cf/src/session.ts" | grep -i -q "sessionId\|session_id"; then
echo "session id now threads near completeSimple; the SKIP reason is stale"
exit 1
fi
echo "SKIP CACHE-01: no session id threads into completeSimple (session.ts:${CS_LINE}), so no per-session cache key exists to prove."
printf '%s\n' "SKIP CACHE-01: no session id threads into completeSimple (session.ts:${CS_LINE}), so no per-session cache key exists to prove." > "${OUT}/p7-cache-skip.txt"
S7="skip"
else
echo "SKIP proof 7 (stopped)"
fi

if [ "${STOP}" = "0" ]; then
echo "### 12 proof 8: per-path total plus the meta rollup cross-check"
${CLI} meta --ws "${WSA}" --sid "${SIDA}" --base "${BASE}" --json > "${OUT}/rollup-meta-A.json" || exit 1
if [ -n "${SIDB:-}" ]; then ${CLI} meta --ws "${WSB}" --sid "${SIDB}" --base "${BASE}" --json > "${OUT}/rollup-meta-B.json" || exit 1; fi
if [ -n "${SIDC:-}" ]; then ${CLI} meta --ws "${WSC}" --sid "${SIDC}" --base "${BASE}" --json > "${OUT}/rollup-meta-C.json" || exit 1; fi
if [ -n "${SIDD:-}" ]; then ${CLI} meta --ws "${WSD}" --sid "${SIDD}" --base "${BASE}" --json > "${OUT}/rollup-meta-D.json" || exit 1; fi
if [ -n "${SIDG:-}" ]; then ${CLI} meta --ws "${WSG}" --sid "${SIDG}" --base "${BASE}" --json > "${OUT}/rollup-meta-G.json" || exit 1; fi
node -e "
const fs = require('node:fs');
const OUT = '${OUT}';
const ledger = fs.readFileSync(OUT + '/ledger.txt', 'utf8').trim().split('\n').filter((l) => l.length > 0);
const per = {};
const total = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0 };
for (const line of ledger) {
  const sp = line.indexOf(' ');
  const sid = line.slice(0, sp);
  const file = line.slice(sp + 1);
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  const u = b.usage;
  if (!u) throw new Error('ledger file misses usage: ' + file);
  if (!per[sid]) per[sid] = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, n: 0 };
  for (const k of ['inTokens', 'outTokens', 'cacheRead', 'costTotal', 'elapsedMs']) { per[sid][k] += u[k] || 0; total[k] += u[k] || 0; }
  per[sid].n += 1;
}
const metas = { '${SIDA}': 'rollup-meta-A.json' };
if ('${SIDB:-}' !== '') metas['${SIDB}'] = 'rollup-meta-B.json';
if ('${SIDC:-}' !== '') metas['${SIDC}'] = 'rollup-meta-C.json';
if ('${SIDD:-}' !== '') metas['${SIDD}'] = 'rollup-meta-D.json';
if ('${SIDG:-}' !== '') metas['${SIDG}'] = 'rollup-meta-G.json';
for (const [sid, name] of Object.entries(metas)) {
  const m = JSON.parse(fs.readFileSync(OUT + '/' + name, 'utf8'));
  const u = m.usage || {};
  const p = per[sid];
  if (!p) throw new Error('ledger misses session ' + sid);
  for (const k of ['inTokens', 'outTokens', 'cacheRead', 'elapsedMs']) {
    if ((u[k] || 0) !== p[k]) throw new Error('rollup mismatch ' + sid + ' ' + k + ': meta=' + u[k] + ' ledger=' + p[k]);
  }
  if (Math.abs((u.costTotal || 0) - p.costTotal) > 1e-9) throw new Error('rollup mismatch ' + sid + ' costTotal');
  console.log('rollup ok: ' + sid.slice(0, 8) + ' ' + p.n + ' turns match meta');
}
console.log('TOTAL in=' + total.inTokens + ' out=' + total.outTokens + ' cacheRead=' + total.cacheRead + ' cost=' + total.costTotal + ' elapsed=' + total.elapsedMs + 'ms');
" || exit 1
S8="green"
else
echo "SKIP proof 8 (stopped)"
fi

echo "### 13 proof 9: delete the temp secret file, verify absence, redaction grep"
if [ "${CREATED}" = "1" ]; then
rm -f worker/.dev.vars
CREATED=0
fi
if [ -e worker/.dev.vars ]; then
echo "temp secret file still present; refusing to finish"
exit 1
fi
echo "secret file absent ok"
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

if [ "${STOP}" = "1" ]; then
[ "${S1}" = "pending" ] && S1="blocked"
[ "${S2}" = "pending" ] && S2="blocked"
[ "${S3}" = "pending" ] && S3="blocked"
[ "${S4}" = "pending" ] && S4="blocked"
[ "${S5}" = "pending" ] && S5="blocked"
[ "${S6}" = "pending" ] && S6="blocked"
[ "${S7}" = "pending" ] && S7="blocked"
[ "${S8}" = "pending" ] && S8="blocked"
fi
echo "proofs: shakeout=${S0} factory=${S1} thinking=${S2} stream=${S3} abort=${S4} steer=${S5} reserve=${S6} cache=${S7} rollup=${S8} failed_on_code=${FAILED_CODE} stopped=${STOP}"
if [ "${FAILED_CODE}" != "0" ]; then
exit 1
fi
if [ "${STOP}" = "1" ]; then
echo "STOPPED ${RUN_ID}; stop note kept at ${OUT}/stop-note.txt"
fi
} 2>&1 | tee "${OUT}/transcript.txt"
exit "${PIPESTATUS[0]}"
