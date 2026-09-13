#!/bin/sh
# wait-routine.sh — poll a session's entries until a routine-fired turn shows
# up (or a deadline passes). Reads only; safe against a foreign instance.
# Usage: sh helpers/wait-routine.sh BASE WS SID RID CURSOR TIMEOUT_S
# Exit 0: found; prints the cursor of the first matching entry.
# Exit 1: timeout with no matching entry; prints nothing on stdout.
# The match is on `routineId` in the entry body (prompt and error entries
# carry it via recordTurnWithOpen).
BASE="${1:?BASE}"
WS="${2:?WS}"
SID="${3:?SID}"
RID="${4:?RID}"
CURSOR="${5:?CURSOR}"
TIMEOUT="${6:-180}"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BODY="$(curl -s --max-time 10 "${BASE}/workspaces/${WS}/sessions/${SID}/entries?after=${CURSOR}&limit=1000")" || { sleep 2; continue; }
  HIT="$(printf '%s' "${BODY}" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try {
        const j=JSON.parse(d);
        const hit=(j.entries||[]).find(e=>JSON.stringify(e.body||e).includes(process.argv[1]));
        process.stdout.write(hit ? String(hit.cursor) : "");
      } catch { }
    })' "${RID}")"
  if [ -n "${HIT}" ]; then
    echo "${HIT}"
    exit 0
  fi
  sleep 2
done
echo "timeout: no routine entry for ${RID} within ${TIMEOUT}s" >&2
exit 1
