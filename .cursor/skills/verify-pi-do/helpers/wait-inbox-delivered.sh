#!/bin/sh
# wait-inbox-delivered.sh — poll a session's inbox until a message shows up as
# delivered (or a deadline passes). Reads only; safe against a foreign
# instance.
# Usage: sh helpers/wait-inbox-delivered.sh BASE WS SID MSGID TIMEOUT_S
# Exit 0: found; prints the JSON of the matching message row.
# Exit 1: timeout with no delivered message; prints nothing on stdout.
# Exit 2: usage error.
# DRAFT: the list route (`GET {BASE}/workspaces/{WS}/sessions/{SID}/inbox`)
# and the field names (`message.id`, `message.deliveredAt`) are TBD until the
# inbox PR lands — confirm against the implementation, then move this file to
# helpers/ unchanged.
BASE="${1:?BASE}"
WS="${2:?WS}"
SID="${3:?SID}"
MSGID="${4:?MSGID}"
TIMEOUT="${5:-120}"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BODY="$(curl -s --max-time 10 "${BASE}/workspaces/${WS}/sessions/${SID}/inbox")" || { sleep 2; continue; }
  ROW="$(printf '%s' "${BODY}" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try {
        const j=JSON.parse(d);
        const rows=j.messages||j.entries||j||[];
        const hit=(Array.isArray(rows)?rows:[]).find(m=>String(m.id||m.messageId)===process.argv[1]&&m.deliveredAt);
        process.stdout.write(hit ? JSON.stringify(hit) : "");
      } catch { }
    })' "${MSGID}")"
  if [ -n "${ROW}" ]; then
    echo "${ROW}"
    exit 0
  fi
  sleep 2
done
echo "timeout: message ${MSGID} not delivered within ${TIMEOUT}s" >&2
exit 1
