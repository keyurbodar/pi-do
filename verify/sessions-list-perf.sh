#!/bin/sh
# sessions-list-perf.sh — measures GET /workspaces/:id/sessions latency at
# realistic roster scale: one workspace, N sessions (10, 100, 300) each with
# two entries seeded through POST /sessions/:sid/thinking (the cheapest
# entry-writing route; no model turn), then a handful of timed GETs per N
# reporting p50/max. Measurement only: PASS means the timing table was
# recorded. Owns its worker (:8797, scratch persist, keyless stub).
# Usage: sh verify/sessions-list-perf.sh
# Exit 0 on pass, 1 otherwise. Writes artifacts/RUN_ID/sessions-list-perf/.
set -u
BASE="http://127.0.0.1:8797"
RUN_ID="verify-$(date +%s)"
CLI="node cli/bin/pi-do.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/artifacts/${RUN_ID}/sessions-list-perf"
mkdir -p "${OUT}"
PORT="8797"
SAMPLES="7"
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/sessions-list-perf-XXXXXX")"
cd "${ROOT}"

cleanup() {
  if [ -f "${TMPBASE}/dev.pid" ]; then kill "$(cat "${TMPBASE}/dev.pid")" 2>/dev/null; fi
  return 0
}
trap cleanup EXIT
fail() { echo "FAIL sessions-list-perf: $1"; exit 1; }

{
echo "### 1 dev server up on ${PORT} (keyless stub)"
(cd "${ROOT}/worker" && exec env -u MODEL_ID -u OPENCODE_API_KEY npx wrangler dev --port "${PORT}" --persist-to "${TMPBASE}/persist" > "${OUT}/dev.log" 2>&1 & echo "$!" > "${TMPBASE}/dev.pid")
i=0
while ! curl -sf --max-time 2 "${BASE}/" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "${i}" -ge 90 ]; then fail "dev never became ready on ${BASE} (see ${OUT}/dev.log)"; fi
  sleep 1
done
echo "dev ready on ${BASE}"

echo "### 2 workspace create"
WS_JSON="$(${CLI} workspace create --base "${BASE}" --json)" || fail "workspace create"
printf '%s' "${WS_JSON}" > "${OUT}/ws.json"
WS="$(node -p "JSON.parse(process.argv[1]).workspaceId" "${WS_JSON}")"
echo "WS=${WS}"

echo "### 3 measure.mjs: seed to N then time the sessions GET"
cat > "${OUT}/measure.mjs" <<'EOF'
import { writeFileSync } from "node:fs";
const [base, ws, targetStr, samplesStr, out] = process.argv.slice(2);
const target = Number(targetStr);
const samples = Number(samplesStr);
const get = async () => {
  const t0 = performance.now();
  const r = await fetch(`${base}/workspaces/${ws}/sessions`);
  const body = await r.text();
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`GET sessions ${r.status}: ${body}`);
  return { ms, body };
};
const post = async (path, payload) => {
  const r = await fetch(`${base}/workspaces/${ws}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`POST ${path} ${r.status}: ${await r.text()}`);
  return r.json();
};
const have = JSON.parse((await get()).body).sessions.length;
const need = target - have;
let next = have;
const seedOne = async () => {
  while (next < target) {
    const i = next++;
    const s = await post("/sessions", { name: `perf-${String(i).padStart(4, "0")}` });
    await post(`/sessions/${s.sessionId}/thinking`, { level: "low" });
    await post(`/sessions/${s.sessionId}/thinking`, { level: "off" });
  }
};
await Promise.all(Array.from({ length: 16 }, seedOne));
const check = JSON.parse((await get()).body);
if (check.sessions.length !== target) throw new Error(`expected ${target} sessions, got ${check.sessions.length}`);
for (const s of check.sessions) {
  if (s.count !== 2 || !(s.head > 0)) throw new Error(`session ${s.sid} missing seeded entries: ${JSON.stringify(s)}`);
}
const times = [];
let lastBody = "";
for (let i = 0; i < samples; i++) {
  const s = await get();
  times.push(s.ms);
  lastBody = s.body;
}
times.sort((a, b) => a - b);
const p50 = times[Math.floor((times.length - 1) / 2)];
const max = times[times.length - 1];
writeFileSync(`${out}/sessions-${target}.json`, lastBody);
writeFileSync(`${out}/samples-${target}.json`, JSON.stringify(times.map((t) => Math.round(t * 10) / 10)));
const norm = JSON.parse(lastBody);
norm.sessions = norm.sessions
  .map((s) => ({ sid: "<sid>", name: s.name, backstory: s.backstory, created: "<ts>", openRun: s.openRun, head: s.head > 0, count: s.count }))
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(`${out}/sessions-${target}-normalized.json`, JSON.stringify(norm, null, 2) + "\n");
console.log(`N=${target} seeded=${need} p50=${p50.toFixed(1)}ms max=${max.toFixed(1)}ms`);
EOF

for N in 10 100 300; do
  LINE="$(node "${OUT}/measure.mjs" "${BASE}" "${WS}" "${N}" "${SAMPLES}" "${OUT}")" || fail "measure N=${N}"
  echo "${LINE}" | tee -a "${OUT}/timings.txt"
  echo "PASS N=${N} ${LINE}"
done

echo "PASS sessions-list-perf: all checks green"
} 2>&1 | tee "${OUT}/transcript.txt"
