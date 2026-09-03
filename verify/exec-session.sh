#!/bin/sh
# exec-session.sh — proves persistent exec sessions: state persists across
# calls in one session (export then echo), cwd persists, kill stops a sleep
# with a timedOut-style result, dispose drops the session, a second sid is
# isolated from the first, and sessions never touch VFS rows.
# Usage: sh verify/exec-session.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/exec-session/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/exec-session"
mkdir -p "${OUT}"
SID_A="sess-a-${RUN_ID}"
SID_B="sess-b-${RUN_ID}"

post() {
  # post <path> <json-body> <outfile>
  node -e "
fetch(process.argv[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[2] })
  .then(async (r) => ({ status: r.status, body: await r.text() }))
  .then((o) => { require('node:fs').writeFileSync(process.argv[3], JSON.stringify(o)); console.log(process.argv[3] + ' status=' + o.status + ' ' + o.body.slice(0, 200)); })
  .catch((e) => { console.error('fetch failed: ' + e.message); process.exit(1); });
" "${BASE}${1}" "${2}" "${OUT}/${3}"
}

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
EXEC="/workspaces/${WS}/exec"

echo "### 2 session A persists env across calls"
post "${EXEC}" '{"command":"export FOO=bar","sid":"'"${SID_A}"'"}' a-export.json || exit 1
post "${EXEC}" '{"command":"echo $FOO","sid":"'"${SID_A}"'"}' a-echo.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (b.exit !== 0) throw new Error('expected exit 0, got ' + b.exit);
if (!String(b.stdout).includes('bar')) throw new Error('state lost: stdout=' + JSON.stringify(b.stdout));
console.log('persist ok: second call sees FOO=bar');
" "${OUT}/a-echo.json" || exit 1

echo "### 3 session A persists cwd"
post "${EXEC}" '{"command":"mkdir -p subdir && cd subdir && pwd","sid":"'"${SID_A}"'"}' a-cd.json || exit 1
post "${EXEC}" '{"command":"pwd","sid":"'"${SID_A}"'"}' a-pwd.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = JSON.parse(o.body);
if (!String(b.stdout).includes('subdir')) throw new Error('cwd lost: stdout=' + JSON.stringify(b.stdout));
console.log('cwd ok: ' + b.stdout.trim());
" "${OUT}/a-pwd.json" || exit 1

echo "### 4 session B is isolated from A"
post "${EXEC}" '{"command":"echo $FOO","sid":"'"${SID_B}"'"}' b-echo.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = JSON.parse(o.body);
if (String(b.stdout).includes('bar')) throw new Error('isolation broken: B sees FOO from A');
" "${OUT}/b-echo.json" || exit 1

echo "### 5 kill stops a sleep with a timedOut-style result"
START="$(date +%s)"
post "${EXEC}" '{"command":"sleep 20","sid":"'"${SID_A}"'"}' a-sleep.json &
SLEEPPID="$!"
sleep 2
post "${EXEC}/kill" '{"sid":"'"${SID_A}"'"}' a-kill.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 200) throw new Error('expected 200, got ' + o.status + ' ' + o.body);
if (JSON.parse(o.body).killed !== true) throw new Error('expected {killed:true}, got ' + o.body);
console.log('kill accepted');
" "${OUT}/a-kill.json" || exit 1
wait "${SLEEPPID}"
END="$(date +%s)"
ELAPSED="$((END - START))"
echo "sleep call settled after ${ELAPSED}s"
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 408) throw new Error('expected 408, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (!String(b.error).includes('killed')) throw new Error('expected killed error, got ' + o.body);
if (typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('kill ok: ' + b.error);
" "${OUT}/a-sleep.json" || exit 1
if [ "${ELAPSED}" -ge 9 ]; then
  echo "kill too slow: ${ELAPSED}s looks like the 10s timeout, not the kill"
  exit 1
fi

echo "### 6 dispose drops the session"
post "${EXEC}/dispose" '{"sid":"'"${SID_A}"'"}' a-dispose.json || exit 1
post "${EXEC}" '{"command":"echo $FOO; pwd","sid":"'"${SID_A}"'"}' a-fresh.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = JSON.parse(o.body);
if (String(b.stdout).includes('bar')) throw new Error('dispose failed: FOO survived');
if (String(b.stdout).includes('subdir')) throw new Error('dispose failed: cwd survived');
console.log('dispose ok: fresh session stdout=' + JSON.stringify(b.stdout));
" "${OUT}/a-fresh.json" || exit 1

echo "### 7 unknown sid kill is 404 with a hint"
post "${EXEC}/kill" '{"sid":"nope-'"${RUN_ID}"'"}' missing.json || exit 1
node -e "
const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (o.status !== 404) throw new Error('expected 404, got ' + o.status + ' ' + o.body);
const b = JSON.parse(o.body);
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" "${OUT}/missing.json" || exit 1

echo "### 8 sessions never touch VFS rows (second view)"
LS_JSON="$(${CLI} files ls --ws "${WS}" --path "" --base "${BASE}" --json)" || exit 1
echo "${LS_JSON}"
printf '%s' "${LS_JSON}" > "${OUT}/ls.json"
node -e "
const b = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const n = Array.isArray(b.entries) ? b.entries.length : -1;
if (n !== 0) throw new Error('expected 0 entries, got ' + n);
console.log('no entries ok');
" "${OUT}/ls.json" || exit 1

echo "PASS ${RUN_ID} ws=${WS}"
} 2>&1 | tee "${OUT}/transcript.txt"
