#!/bin/sh
# git-smoke.sh — proves session mint + narrow git allowlist over a fresh workspace.
# Usage: sh verify/git-smoke.sh [BASE]
# Exit 0 when every assert passes, 1 otherwise. Writes artifacts/RUN_ID/git-smoke/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/git-smoke"
mkdir -p "${OUT}"

need_hint() {
  # need_hint FILE — body must be JSON with string error + hint fields.
  node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof body.error !== "string" || body.error.length === 0) process.exit(1);
if (typeof body.hint !== "string" || body.hint.length === 0) process.exit(1);
' "$1"
}

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
test -n "${WS}" || { echo "FAIL: empty workspace id"; exit 1; }

echo "### 2 session create"
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"
test -n "${SID}" || { echo "FAIL: empty session id"; exit 1; }

echo "### 3 git status on empty workspace is structured not-a-repo (never 500)"
CODE="$(curl -s -o "${OUT}/status.body" -w '%{http_code}' --max-time 10 -X POST \
  "${BASE}/workspaces/${WS}/sessions/${SID}/git" \
  -H 'content-type: application/json' -d '{"argv":["status"]}')"
echo "status code=${CODE}"
cat "${OUT}/status.body"; echo
test "${CODE}" = "404" || { echo "FAIL: expected 404 not-a-repo, got ${CODE}"; exit 1; }
need_hint "${OUT}/status.body" || { echo "FAIL: not-a-repo body needs error+hint"; exit 1; }
grep -q "not a git repository" "${OUT}/status.body" || { echo "FAIL: body must say not a git repository"; exit 1; }
echo "PASS not-a-repo"

echo "### 4 git push is 403 and nothing executes"
CODE="$(curl -s -o "${OUT}/push.body" -w '%{http_code}' --max-time 10 -X POST \
  "${BASE}/workspaces/${WS}/sessions/${SID}/git" \
  -H 'content-type: application/json' -d '{"argv":["push","origin","main"]}')"
echo "push code=${CODE}"
cat "${OUT}/push.body"; echo
test "${CODE}" = "403" || { echo "FAIL: expected 403 on push, got ${CODE}"; exit 1; }
need_hint "${OUT}/push.body" || { echo "FAIL: 403 body needs error+hint"; exit 1; }
LS_BEFORE="$(curl -s --max-time 10 "${BASE}/workspaces/${WS}/files?list=")"
CODE2="$(curl -s -o "${OUT}/status2.body" -w '%{http_code}' --max-time 10 -X POST \
  "${BASE}/workspaces/${WS}/sessions/${SID}/git" \
  -H 'content-type: application/json' -d '{"argv":["status"]}')"
LS_AFTER="$(curl -s --max-time 10 "${BASE}/workspaces/${WS}/files?list=")"
test "${CODE2}" = "404" || { echo "FAIL: status after push must stay 404, got ${CODE2}"; exit 1; }
test "${LS_BEFORE}" = "${LS_AFTER}" || { echo "FAIL: files changed after rejected push"; exit 1; }
echo "PASS push 403, nothing executed"

echo "### 5 commit without a repo is structured not-a-repo (never 501/500)"
CODE="$(curl -s -o "${OUT}/commit.body" -w '%{http_code}' --max-time 10 -X POST \
  "${BASE}/workspaces/${WS}/sessions/${SID}/git" \
  -H 'content-type: application/json' -d '{"argv":["commit","-m","x"]}')"
echo "commit code=${CODE}"
cat "${OUT}/commit.body"; echo
test "${CODE}" = "404" || { echo "FAIL: expected 404 not-a-repo, got ${CODE}"; exit 1; }
need_hint "${OUT}/commit.body" || { echo "FAIL: not-a-repo body needs error+hint"; exit 1; }
grep -q "not a git repository" "${OUT}/commit.body" || { echo "FAIL: body must say not a git repository"; exit 1; }
echo "PASS commit without repo 404"

echo "### 6 unknown workspace session mint is 404 with hint"
CODE="$(curl -s -o "${OUT}/nosuch-ws.body" -w '%{http_code}' --max-time 10 -X POST \
  "${BASE}/workspaces/does-not-exist-0000/sessions")"
echo "unknown-ws code=${CODE}"
cat "${OUT}/nosuch-ws.body"; echo
test "${CODE}" = "404" || { echo "FAIL: expected 404 unknown workspace, got ${CODE}"; exit 1; }
need_hint "${OUT}/nosuch-ws.body" || { echo "FAIL: unknown-workspace body needs error+hint"; exit 1; }
echo "PASS unknown workspace 404"

echo "### 7 unknown session git is 404 with hint"
CODE="$(curl -s -o "${OUT}/nosuch-sid.body" -w '%{http_code}' --max-time 10 -X POST \
  "${BASE}/workspaces/${WS}/sessions/does-not-exist-0000/git" \
  -H 'content-type: application/json' -d '{"argv":["status"]}')"
echo "unknown-sid code=${CODE}"
cat "${OUT}/nosuch-sid.body"; echo
test "${CODE}" = "404" || { echo "FAIL: expected 404 unknown session, got ${CODE}"; exit 1; }
need_hint "${OUT}/nosuch-sid.body" || { echo "FAIL: unknown-session body needs error+hint"; exit 1; }
echo "PASS unknown session 404"

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
