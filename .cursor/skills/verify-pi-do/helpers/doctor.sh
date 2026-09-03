#!/bin/sh
# doctor.sh — read-only reachability probe for a pi-do front-door Worker.
# Usage: sh helpers/doctor.sh [BASE_URL]
# Exit 0: something answers HTTP at BASE. Exit 2: absent/unreachable.
# Creates no workspaces, opens no sockets, writes nothing.
BASE="${1:-http://127.0.0.1:8787}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/" 2>/dev/null)" || CODE="000"
if [ "${CODE}" = "000" ]; then
  echo "absent: nothing listening at ${BASE} (expected pre-PR01)"
  exit 2
fi
echo "listening: ${BASE} answered HTTP ${CODE}"
exit 0
