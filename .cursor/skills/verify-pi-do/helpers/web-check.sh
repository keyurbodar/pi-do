#!/bin/sh
# web-check.sh — fast path for the pi-do web surface (SKILL.md "Web surface").
# One pass, well under a minute: page load check, console-error capture,
# screenshot. No retries, no re-proving: one failed check is reported, exit
# code says which.
#
# Usage: sh helpers/web-check.sh [URL] [OUT_DIR]
#   URL      default http://localhost:3000 (the shared dev server — never
#            start a second instance on 3000)
#   OUT_DIR  default artifacts/web-check; receives page.png, console.log
#
# Exit codes:
#   0  page loads (HTTP 200) and zero console errors
#   1  page loads but console errors were captured (failed launch)
#   2  page unreachable / non-200
#   3  load check ran, but no Chromium-family browser found for
#      console/screenshot — run those steps through the interactive browser
#      harness instead and record the manual result.
#
# Browser resolution: $PI_DO_BROWSER, then common macOS app bundles, then
# chromium/chrome on PATH.

set -u

URL="${1:-http://localhost:3000}"
OUT_DIR="${2:-artifacts/web-check}"
BUDGET_MS=8000

mkdir -p "$OUT_DIR"

# 1. Load check (5s timeout — a hung server is a failed check, not a wait).
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL")
if [ "$status" != "200" ]; then
  echo "web-check: $URL answered HTTP $status (want 200)" >&2
  exit 2
fi
echo "load: HTTP 200 at $URL"

# 2. Find a browser for console capture + screenshot.
browser="${PI_DO_BROWSER:-}"
if [ -z "$browser" ]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "$(command -v chromium 2>/dev/null || true)" \
    "$(command -v chrome 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      browser="$candidate"
      break
    fi
  done
fi

if [ -z "$browser" ]; then
  echo "web-check: no Chromium-family browser found (set PI_DO_BROWSER); load check passed, console/screenshot NOT captured" >&2
  exit 3
fi

# 3. Headless pass: screenshot + console log on stderr.
#    --virtual-time-budget lets the React bootstrap settle before capture.
stderr="$OUT_DIR/console.raw"
if ! "$browser" --headless=new --disable-gpu --no-first-run \
    --user-data-dir="$(mktemp -d)" \
    --enable-logging=stderr --v=0 \
    --virtual-time-budget="$BUDGET_MS" \
    --window-size=1280,900 \
    --screenshot="$OUT_DIR/page.png" \
    "$URL" 2>"$stderr" >/dev/null; then
  echo "web-check: browser run failed; stderr kept at $stderr" >&2
  exit 1
fi

# 4. Console record: keep every CONSOLE line, flag errors.
grep -E 'CONSOLE' "$stderr" >"$OUT_DIR/console.log" 2>/dev/null || : >"$OUT_DIR/console.log"
rm -f "$stderr"
errors=$(grep -cE 'CONSOLE.*("[Ee]rror|Uncaught|Failed to load)' "$OUT_DIR/console.log" 2>/dev/null || true)

echo "web-check: screenshot $OUT_DIR/page.png; console lines $(wc -l <"$OUT_DIR/console.log" | tr -d ' '), errors $errors"
if [ "$errors" -gt 0 ]; then
  echo "web-check: FAILED — console errors at load (see $OUT_DIR/console.log)" >&2
  exit 1
fi
echo "web-check: PASS (0 console errors)"
exit 0
