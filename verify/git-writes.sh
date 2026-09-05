#!/bin/sh
# git-writes.sh — proves local git writes (init/add/commit/rm/checkout) over a fresh workspace.
# Usage: sh verify/git-writes.sh [BASE]
# Exit 0 when every assert passes, 1 otherwise. Writes artifacts/RUN_ID/git-writes/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="artifacts/${RUN_ID}/git-writes"
mkdir -p "${OUT}"

need_hint() {
  node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof body.error !== "string" || body.error.length === 0) process.exit(1);
if (typeof body.hint !== "string" || body.hint.length === 0) process.exit(1);
' "$1"
}
git_call() {
  _out="$1"
  _argv="$2"
  curl -s -o "${_out}" -w '%{http_code}' --max-time 10 -X POST \
    "${BASE}/workspaces/${WS}/sessions/${SID}/git" \
    -H 'content-type: application/json' -d "{\"argv\":${_argv}}"
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

echo "### 3 git init creates a repo"
CODE="$(git_call "${OUT}/init.body" '["init"]')"
echo "init code=${CODE}"
cat "${OUT}/init.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on init, got ${CODE}"; exit 1; }
CODE="$(git_call "${OUT}/status-empty.body" '["status"]')"
echo "status-after-init code=${CODE}"
cat "${OUT}/status-empty.body"; echo
test "${CODE}" = "200" || { echo "FAIL: status after init must be 200, got ${CODE}"; exit 1; }
echo "PASS init creates a repo"

echo "### 4 files put + add + commit round-trips"
printf '%s' "hello-writes-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "hello.txt" --base "${BASE}" --json || exit 1
CODE="$(git_call "${OUT}/add.body" '["add","hello.txt"]')"
echo "add code=${CODE}"
cat "${OUT}/add.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on add, got ${CODE}"; exit 1; }
CODE="$(git_call "${OUT}/commit.body" '["commit","-m","first commit"]')"
echo "commit code=${CODE}"
cat "${OUT}/commit.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on commit, got ${CODE}"; exit 1; }
OID="$(node -p 'const b=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));(b.commit&&b.commit.oid)||((b.stdout||"").match(/[0-9a-f]{40}/)||[])[0]||""' "${OUT}/commit.body")"
echo "OID=${OID}"
test -n "${OID}" || { echo "FAIL: empty commit oid"; exit 1; }
CODE="$(git_call "${OUT}/status.body" '["status"]')"
echo "status code=${CODE}"
cat "${OUT}/status.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on status, got ${CODE}"; exit 1; }
node -e '
const b = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if ((b.files || []).length !== 0) throw new Error("status not clean: " + JSON.stringify(b.files));
if ((b.stdout || "").trim() !== "") throw new Error("status stdout not empty: " + JSON.stringify(b.stdout));
' "${OUT}/status.body" || { echo "FAIL: status not clean after commit"; exit 1; }
CODE="$(git_call "${OUT}/log.body" '["log"]')"
echo "log code=${CODE}"
cat "${OUT}/log.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on log, got ${CODE}"; exit 1; }
node -e '
const b = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const msgs = (b.commits || []).map((c) => c.message).join("\n") + "\n" + (b.stdout || "");
if (!msgs.includes("first commit")) throw new Error("log missing first commit: " + JSON.stringify(msgs));
' "${OUT}/log.body" || { echo "FAIL: log missing first commit"; exit 1; }
CODE="$(git_call "${OUT}/show.body" '["show","HEAD"]')"
echo "show code=${CODE}"
cat "${OUT}/show.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on show, got ${CODE}"; exit 1; }
SHOW_OID="$(node -p 'const b=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));(b.commit&&b.commit.oid)||((b.stdout||"").match(/[0-9a-f]{40}/)||[])[0]||""' "${OUT}/show.body")"
test "${SHOW_OID}" = "${OID}" || { echo "FAIL: show HEAD ${SHOW_OID} != commit ${OID}"; exit 1; }
echo "PASS add + commit round-trip"

echo "### 5 rm + commit removes"
CODE="$(git_call "${OUT}/rm.body" '["rm","hello.txt"]')"
echo "rm code=${CODE}"
cat "${OUT}/rm.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on rm, got ${CODE}"; exit 1; }
CODE="$(git_call "${OUT}/commit-rm.body" '["commit","-m","remove hello"]')"
echo "commit-rm code=${CODE}"
cat "${OUT}/commit-rm.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on rm commit, got ${CODE}"; exit 1; }
if ${CLI} files get --ws "${WS}" --path "hello.txt" --base "${BASE}" --out "${OUT}/gone.bin" 2>"${OUT}/gone.stderr"; then
  echo "FAIL: expected get-after-rm-commit to fail"; exit 1
fi
echo "rm confirmed by second-view get"
CODE="$(git_call "${OUT}/status-rm.body" '["status"]')"
test "${CODE}" = "200" || { echo "FAIL: expected 200 on status after rm commit, got ${CODE}"; exit 1; }
node -e '
const b = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if ((b.files || []).length !== 0) throw new Error("status not clean: " + JSON.stringify(b.files));
' "${OUT}/status-rm.body" || { echo "FAIL: status not clean after rm commit"; exit 1; }
echo "PASS rm + commit removes"

echo "### 6 checkout -b round-trips"
CODE="$(git_call "${OUT}/checkout.body" '["checkout","-b","feature"]')"
echo "checkout code=${CODE}"
cat "${OUT}/checkout.body"; echo
test "${CODE}" = "200" || { echo "FAIL: expected 200 on checkout -b, got ${CODE}"; exit 1; }
printf '%s' "on-feature-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "feature.txt" --base "${BASE}" --json || exit 1
CODE="$(git_call "${OUT}/add-feature.body" '["add","feature.txt"]')"
test "${CODE}" = "200" || { echo "FAIL: expected 200 on feature add, got ${CODE}"; exit 1; }
CODE="$(git_call "${OUT}/commit-feature.body" '["commit","-m","on feature"]')"
test "${CODE}" = "200" || { echo "FAIL: expected 200 on feature commit, got ${CODE}"; exit 1; }
CODE="$(git_call "${OUT}/log-feature.body" '["log"]')"
test "${CODE}" = "200" || { echo "FAIL: expected 200 on log after feature commit, got ${CODE}"; exit 1; }
node -e '
const b = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const msgs = (b.commits || []).map((c) => c.message).join("\n") + "\n" + (b.stdout || "");
if (!msgs.includes("on feature")) throw new Error("log missing feature commit");
if (!msgs.includes("remove hello")) throw new Error("history lost across checkout -b");
' "${OUT}/log-feature.body" || { echo "FAIL: feature branch history wrong"; exit 1; }
echo "PASS checkout -b round-trip"

echo "### 7 push/clone/fetch are 403 and change nothing"
CODE="$(git_call "${OUT}/before-status.body" '["status"]')"
test "${CODE}" = "200" || { echo "FAIL: expected 200 on pre-403 status, got ${CODE}"; exit 1; }
ST_BEFORE="$(cat "${OUT}/before-status.body")"
LS_BEFORE="$(curl -s --max-time 10 "${BASE}/workspaces/${WS}/files?list=")"
CODE="$(git_call "${OUT}/push.body" '["push","origin","main"]')"
echo "push code=${CODE}"
cat "${OUT}/push.body"; echo
test "${CODE}" = "403" || { echo "FAIL: expected 403 on push, got ${CODE}"; exit 1; }
need_hint "${OUT}/push.body" || { echo "FAIL: push 403 body needs error+hint"; exit 1; }
CODE="$(git_call "${OUT}/clone.body" '["clone","https://example.invalid/r.git"]')"
echo "clone code=${CODE}"
cat "${OUT}/clone.body"; echo
test "${CODE}" = "403" || { echo "FAIL: expected 403 on clone, got ${CODE}"; exit 1; }
need_hint "${OUT}/clone.body" || { echo "FAIL: clone 403 body needs error+hint"; exit 1; }
CODE="$(git_call "${OUT}/fetch.body" '["fetch","origin"]')"
echo "fetch code=${CODE}"
cat "${OUT}/fetch.body"; echo
test "${CODE}" = "403" || { echo "FAIL: expected 403 on fetch, got ${CODE}"; exit 1; }
need_hint "${OUT}/fetch.body" || { echo "FAIL: fetch 403 body needs error+hint"; exit 1; }
CODE="$(git_call "${OUT}/after-status.body" '["status"]')"
test "${CODE}" = "200" || { echo "FAIL: status after 403s must stay 200, got ${CODE}"; exit 1; }
ST_AFTER="$(cat "${OUT}/after-status.body")"
LS_AFTER="$(curl -s --max-time 10 "${BASE}/workspaces/${WS}/files?list=")"
test "${ST_BEFORE}" = "${ST_AFTER}" || { echo "FAIL: status changed after rejected push/clone/fetch"; exit 1; }
test "${LS_BEFORE}" = "${LS_AFTER}" || { echo "FAIL: files changed after rejected push/clone/fetch"; exit 1; }
echo "PASS push clone fetch 403, nothing executed"

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
