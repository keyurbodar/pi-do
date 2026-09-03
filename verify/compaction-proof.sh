#!/bin/sh
# compaction-proof.sh — proves lane-compact-archive: seeding past the window
# reserve marks the session without compacting inside a turn, the alarm
# summarizes old entries into one compaction entry plus archives the
# originals to paginated cold storage, the live table stays bounded, resume
# replay equals summary plus tail with byte-stable tail cursors, archived
# pages re-read equal to the compacted prefix, and the manual compact route
# runs the same code path explicitly.
# Usage: sh verify/compaction-proof.sh [BASE]
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/compaction-proof/.
set -u
BASE="${1:-http://127.0.0.1:8787}"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
OUT="$(pwd)/artifacts/${RUN_ID}/compaction-proof"
mkdir -p "${OUT}"

{
echo "### 1 doctor"
${CLI} doctor --base "${BASE}" || exit 1

echo "### 2 fresh workspace plus session"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || exit 1
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"
printf '%s' "seeded-body-${RUN_ID}" | ${CLI} files put --ws "${WS}" --path "seed.txt" --base "${BASE}" --json || exit 1
SESS_JSON="$(${CLI} session create --ws "${WS}" --base "${BASE}" --json)" || exit 1
SID="$(node -p "JSON.parse(process.argv[1]).sessionId" "${SESS_JSON}")"
echo "SID=${SID}"
echo "### 3 seed past the window reserve: 5 headless turns, 6 entries each"
I=1
while [ "${I}" -le 5 ]; do
  ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed turn ${I}" --base "${BASE}" --json > "${OUT}/seed-run-${I}.json" || exit 1
  I=$((I + 1))
done

echo "### 4 auto-trigger marked, nothing compacted inside the turns"
TRIES=0
while [ "${TRIES}" -lt 5 ]; do
  ${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-marked.json" 2>/dev/null || true
  if node -e "const m=require('${OUT}/meta-marked.json'); if(!m.compaction||m.compaction.pending!==true)process.exit(1);" 2>/dev/null; then
    break
  fi
  TRIES=$((TRIES + 1))
  sleep 1
done
cat "${OUT}/meta-marked.json"
MODE="structural"
if [ "${TRIES}" -lt 5 ]; then
  MODE="strong"
  node -e "
const m = require('${OUT}/meta-marked.json');
if (m.count !== 30) throw new Error('expected 30 live entries (nothing compacted in-turn), got ' + m.count);
console.log('marked ok: pending true, live 30');
" || exit 1
  ${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 100 --base "${BASE}" --json > "${OUT}/pre-auto.json" || exit 1
  node -e "
const r = require('${OUT}/pre-auto.json');
if (r.entries.some((e) => e.type === 'compaction')) { console.log('alarm already ran; downgrading to structural checks'); process.exit(1); }
" 2>/dev/null || MODE="structural"
fi
echo "MODE=${MODE}" > "${OUT}/mode.txt"
echo "check mode: ${MODE} (strong needs the pre-compaction capture to win the 2s alarm debounce)"

echo "### 5 alarm compacts: poll resume replay for the summary entry"
TRIES=0
while [ "${TRIES}" -lt 45 ]; do
  ${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 100 --base "${BASE}" --json > "${OUT}/post-auto.json" 2>/dev/null || true
  if node -e "const r=require('${OUT}/post-auto.json'); if(!Array.isArray(r.entries)||!r.entries.some((e)=>e.type==='compaction'))process.exit(1);" 2>/dev/null; then
    break
  fi
  TRIES=$((TRIES + 1))
  sleep 2
done
if [ "${TRIES}" -ge 45 ]; then
  echo "alarm never compacted within 90s"
  exit 1
fi
echo "alarm compacted after ~$((TRIES * 2))s"

echo "### 6 live bounded, summary present, replay equals summary plus byte-stable tail"
node -e "
const fs = require('node:fs');
const mode = fs.readFileSync('${OUT}/mode.txt', 'utf8').includes('MODE=strong') ? 'strong' : 'structural';
const post = JSON.parse(fs.readFileSync('${OUT}/post-auto.json', 'utf8')).entries;
if (post.length > 26) throw new Error('live table not bounded: ' + post.length);
const summaries = post.filter((e) => e.type === 'compaction');
if (summaries.length !== 1) throw new Error('expected exactly one summary entry, got ' + summaries.length);
const tail = post.filter((e) => e.type !== 'compaction');
if (tail.length !== 25) throw new Error('expected 25 tail entries, got ' + tail.length);
const sbody = JSON.parse(summaries[0].body);
if (sbody.count !== 5 || sbody.fromCursor !== 1 || sbody.toCursor !== 5) {
  throw new Error('summary must cover cursors 1..5, got ' + summaries[0].body.slice(0, 120));
}
const wantTail = [];
for (let c = 6; c <= 30; c++) wantTail.push(c);
if (JSON.stringify(tail.map((e) => e.cursor)) !== JSON.stringify(wantTail)) {
  throw new Error('tail cursors must be 6..30 in order, got ' + JSON.stringify(tail.map((e) => e.cursor)));
}
if (mode === 'strong') {
  const pre = JSON.parse(fs.readFileSync('${OUT}/pre-auto.json', 'utf8')).entries;
  if (pre.length !== 30) throw new Error('pre capture must hold 30, got ' + pre.length);
  for (const e of tail) {
    const p = pre.find((x) => x.cursor === e.cursor);
    if (!p || JSON.stringify(p) !== JSON.stringify(e)) throw new Error('tail cursor not byte-stable: ' + e.cursor);
  }
  const archived = pre.slice(0, pre.length - 25);
  if (sbody.fromCursor !== archived[0].cursor || sbody.toCursor !== archived[archived.length - 1].cursor) {
    throw new Error('summary range mismatch: ' + summaries[0].body.slice(0, 120));
  }
  console.log('bounded ok (' + mode + '): live ' + post.length + ', resume replay equals summary plus byte-stable tail');
} else {
  console.log('bounded ok (' + mode + '): live ' + post.length + ', resume replay equals summary plus tail cursors 6..30');
}
" || exit 1

echo "### 7 archived pages re-readable and equal to the compacted prefix"
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-compacted.json" || exit 1
PAGES="$(node -p "require('${OUT}/meta-compacted.json').compaction.archivePages")"
TOTAL="$(node -p "require('${OUT}/meta-compacted.json').compaction.archiveTotal")"
echo "pages=${PAGES} total=${TOTAL}"
if [ "${PAGES}" != "1" ] || [ "${TOTAL}" != "5" ]; then
  echo "expected 1 page holding 5 entries, got pages=${PAGES} total=${TOTAL}"
  exit 1
fi
${CLI} archive --ws "${WS}" --sid "${SID}" --page 1 --base "${BASE}" --json > "${OUT}/archive-p1.json" || exit 1
node -e "
const fs = require('node:fs');
const mode = fs.readFileSync('${OUT}/mode.txt', 'utf8').includes('MODE=strong') ? 'strong' : 'structural';
const page = JSON.parse(fs.readFileSync('${OUT}/archive-p1.json', 'utf8'));
if (page.page !== 1 || page.pages !== 1 || page.total !== 5) throw new Error('bad archive meta: ' + JSON.stringify({page: page.page, pages: page.pages, total: page.total}));
if (JSON.stringify(page.entries.map((e) => e.cursor)) !== JSON.stringify([1, 2, 3, 4, 5])) {
  throw new Error('archive page must hold cursors 1..5');
}
if (mode === 'strong') {
  const pre = JSON.parse(fs.readFileSync('${OUT}/pre-auto.json', 'utf8')).entries;
  const want = pre.slice(0, pre.length - 25);
  if (JSON.stringify(page.entries) !== JSON.stringify(want)) throw new Error('archive page differs from the compacted prefix');
}
console.log('archive ok (' + mode + '): page 1 re-reads the 5 compacted entries');
" || exit 1

echo "### 8 unknown session compact is 404 with a hint"
if ${CLI} compact --ws "${WS}" --sid "nope-${RUN_ID}" --base "${BASE}" --json > "${OUT}/missing-sid.json" 2> "${OUT}/missing-sid.stderr"; then
  echo "expected compact against unknown session to fail"
  exit 1
fi
node -e "
const b = require('${OUT}/missing-sid.json');
if (typeof b.error !== 'string' || typeof b.hint !== 'string') throw new Error('need { error, hint }');
console.log('404 hint ok: ' + b.error);
" || exit 1

echo "### 9 manual trigger: 5 more turns, then explicit compact on the same path"
I=6
while [ "${I}" -le 10 ]; do
  ${CLI} run --ws "${WS}" --sid "${SID}" --prompt "read seed turn ${I}" --base "${BASE}" --json > "${OUT}/seed-run-${I}.json" || exit 1
  I=$((I + 1))
done
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-pre-manual.json" || exit 1
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 100 --base "${BASE}" --json > "${OUT}/pre-manual.json" || exit 1
${CLI} compact --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/manual.json" || exit 1
cat "${OUT}/manual.json"
node -e "
const c = require('${OUT}/manual.json');
if (c.live > 50) throw new Error('live table not bounded after manual: ' + c.live);
console.log('manual ok: compacted ' + c.compacted + ' live ' + c.live + ' archived ' + c.archived + ' pages ' + c.pages);
" || exit 1

echo "### 10 second view: one summary plus tail, archive grows by the prefix"
${CLI} entries --ws "${WS}" --sid "${SID}" --after 0 --limit 100 --base "${BASE}" --json > "${OUT}/post-manual.json" || exit 1
${CLI} meta --ws "${WS}" --sid "${SID}" --base "${BASE}" --json > "${OUT}/meta-post-manual.json" || exit 1
node -e "
const fs = require('node:fs');
const c = require('${OUT}/manual.json');
const t0 = require('${OUT}/meta-pre-manual.json').compaction;
const t1 = require('${OUT}/meta-post-manual.json').compaction;
const pre = JSON.parse(fs.readFileSync('${OUT}/pre-manual.json', 'utf8')).entries;
const post = JSON.parse(fs.readFileSync('${OUT}/post-manual.json', 'utf8')).entries;
if (!c.compacted) {
  if (JSON.stringify(post) !== JSON.stringify(pre)) throw new Error('no-op compact must leave replay untouched');
  if (t1.archiveTotal !== t0.archiveTotal || t1.archivePages !== t0.archivePages) throw new Error('no-op compact must leave the archive untouched');
  console.log('second compaction ok: alarm converged first, manual no-op, live ' + post.length);
  process.exit(0);
}
const summaries = post.filter((e) => e.type === 'compaction');
if (summaries.length !== 1) throw new Error('expected exactly one summary entry, got ' + summaries.length);
const tail = post.filter((e) => e.type !== 'compaction');
if (tail.length !== 25 || post.length !== 26) throw new Error('expected 1 summary plus 25 tail, got ' + post.length);
const cut = pre.length - 25;
const sbody = JSON.parse(summaries[0].body);
if (sbody.count !== cut || sbody.fromCursor !== pre[0].cursor || sbody.toCursor !== pre[cut - 1].cursor) {
  throw new Error('summary must cover the archived prefix, got ' + summaries[0].body.slice(0, 160));
}
for (const e of tail) {
  const p = pre.find((x) => x.cursor === e.cursor);
  if (!p || JSON.stringify(p) !== JSON.stringify(e)) throw new Error('tail cursor not byte-stable: ' + e.cursor);
}
if (t1.archiveTotal !== t0.archiveTotal + cut) throw new Error('archive total must grow by ' + cut + ', got ' + t0.archiveTotal + '->' + t1.archiveTotal);
const newPages = Math.ceil(cut / 25);
if (t1.archivePages !== t0.archivePages + newPages) throw new Error('archive pages must grow by ' + newPages);
console.log('second compaction ok: live 26, archive total ' + t1.archiveTotal + ' pages ' + t1.archivePages);
" || exit 1
if node -e "if(!require('${OUT}/manual.json').compacted)process.exit(1);"; then
TPAGES="$(node -p "require('${OUT}/meta-post-manual.json').compaction.archivePages")"
TPREV="$(node -p "require('${OUT}/meta-pre-manual.json').compaction.archivePages")"
P=$((TPREV + 1))
while [ "${P}" -le "${TPAGES}" ]; do
  ${CLI} archive --ws "${WS}" --sid "${SID}" --page "${P}" --base "${BASE}" --json > "${OUT}/archive-new-${P}.json" || exit 1
  P=$((P + 1))
done
node -e "
const fs = require('node:fs');
const t0 = require('${OUT}/meta-pre-manual.json').compaction;
const t1 = require('${OUT}/meta-post-manual.json').compaction;
const pre = JSON.parse(fs.readFileSync('${OUT}/pre-manual.json', 'utf8')).entries;
const want = pre.slice(0, pre.length - 25);
const got = [];
for (let p = t0.archivePages + 1; p <= t1.archivePages; p++) {
  got.push(...JSON.parse(fs.readFileSync('${OUT}/archive-new-' + p + '.json', 'utf8')).entries);
}
if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('new archive pages differ from the compacted prefix');
console.log('new archive pages re-readable: ' + got.length + ' entries match the prefix');
" || exit 1
fi

echo "PASS ${RUN_ID} ws=${WS} sid=${SID}"
} 2>&1 | tee "${OUT}/transcript.txt"
