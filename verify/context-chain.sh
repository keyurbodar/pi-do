#!/bin/sh
# context-chain.sh — proves PR49 context loading over the real path: seed
# AGENTS.md at the workspace root and docs/ (plus docs/CLAUDE.md), mint a
# session with cwd docs, then read the composed project context off the meta
# route (?context=1) and assert pi's order — outermost first, cwd-nearest
# last — with per-directory first-match precedence (CLAUDE.md shadowed by
# AGENTS.md in the same dir). Needs a dev server on BASE (default 8787).
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/context-chain/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/context-chain"
mkdir -p "${OUT}"
ROOT_BODY="root-context-${RUN_ID}"
DOCS_BODY="docs-context-${RUN_ID}"
export OUT ROOT_BODY DOCS_BODY RUN_ID

{
echo "### 1 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
echo "${WS_JSON}"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 2 seed context files at root and docs/"
printf '%s' "${ROOT_BODY}" | ${CLI} files put --ws "${WS}" --path "AGENTS.md" --base "${BASE}" --json || exit 1
printf '%s' "${DOCS_BODY}" | ${CLI} files put --ws "${WS}" --path "docs/AGENTS.md" --base "${BASE}" --json || exit 1
printf '%s' "claude-shadowed-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "docs/CLAUDE.md" --base "${BASE}" --json || exit 1

echo "### 3 session with cwd docs"
SESS_JSON="$(${CLI} session create --ws "${WS}" --cwd docs --base "${BASE}" --json)" || exit 1
echo "${SESS_JSON}"
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"

echo "### 4 read the composed context off meta?context=1"
curl -sf "${BASE}/workspaces/${WS}/sessions/${SID}/meta?context=1" -o "${OUT}/meta-context.json" || exit 1
node -p "'context chars=' + (JSON.parse(require('fs').readFileSync('${OUT}/meta-context.json','utf8')).context ?? '').length"
cat "${OUT}/meta-context.json"

echo "### 5 assert chain order and per-directory precedence"
node -e "
const fs = require('node:fs');
const ctx = JSON.parse(fs.readFileSync(process.env.OUT + '/meta-context.json', 'utf8')).context;
if (typeof ctx !== 'string' || ctx.length === 0) throw new Error('meta ?context=1 must carry the composed project context');
const at = (p) => ctx.indexOf('(' + p + '):');
const root = at('AGENTS.md');
const docs = at('docs/AGENTS.md');
if (root === -1 || docs === -1) throw new Error('both AGENTS.md files must appear, got: ' + ctx.slice(0, 200));
if (root > docs) throw new Error('chain must be outermost first, cwd-nearest last');
if (ctx.indexOf('CLAUDE.md') !== -1) throw new Error('docs/CLAUDE.md must be shadowed by docs/AGENTS.md in the same dir');
if (!ctx.includes(process.env.ROOT_BODY) || !ctx.includes(process.env.DOCS_BODY)) throw new Error('file bodies missing from composed context');
if (ctx.indexOf(process.env.ROOT_BODY) > ctx.indexOf(process.env.DOCS_BODY)) throw new Error('root body must precede docs body');
console.log('chain ok: root before docs, CLAUDE.md shadowed, both bodies present');
" || exit 1

echo "### 6 second session at workspace root sees only the root file"
SESS2_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
echo "${SESS2_JSON}"
SID2="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS2_JSON}")"
curl -sf "${BASE}/workspaces/${WS}/sessions/${SID2}/meta?context=1" -o "${OUT}/meta-context-root.json" || exit 1
node -e "
const fs = require('node:fs');
const ctx = JSON.parse(fs.readFileSync(process.env.OUT + '/meta-context-root.json', 'utf8')).context;
if (typeof ctx !== 'string' || !ctx.includes(process.env.ROOT_BODY)) throw new Error('root session must carry the root AGENTS.md body');
if (ctx.indexOf('docs/AGENTS.md') !== -1) throw new Error('root session must not walk into docs/');
console.log('root ok: only the workspace-root file in context');
" || exit 1

echo "PASS context-chain: ancestor walk order + precedence proven over the running worker"
} 2>&1 | tee "${OUT}/transcript.txt"
grep -q "^PASS context-chain" "${OUT}/transcript.txt"
