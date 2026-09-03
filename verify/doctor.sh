#!/bin/sh
# doctor.sh — read-only reachability probe for the pi-do front door.
# Usage: sh verify/doctor.sh [BASE_URL]. Exit 0 listening, 2 absent/unreachable.
# Creates no workspaces, opens no sockets, writes nothing.
BASE="${1:-http://127.0.0.1:8787}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/" 2>/dev/null)" || CODE="000"
if [ "${CODE}" = "000" ]; then
  echo "absent: nothing listening at ${BASE}" >&2
  exit 2
fi
echo "listening: ${BASE} answered HTTP ${CODE}" >&2
exit 0
