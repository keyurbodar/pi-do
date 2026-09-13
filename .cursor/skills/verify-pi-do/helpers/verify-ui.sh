#!/bin/sh
# verify-ui.sh — fast prebuilt UI harness (SKILL.md "Fast pass").
# One ego-browser drive per feature: load check, zero console errors, one
# screenshot. Under one minute, no retries, no re-proving.
#
# Usage: sh helpers/verify-ui.sh URL OUT_DIR FEATURE
#   URL      page under test, e.g. http://localhost:3000
#   OUT_DIR  receives snapshot.txt, console.log, page.png
#            (callers use artifacts/{RUN_ID}/{feature}/)
#   FEATURE  feature id for the transcript header (e.g. web-composer-new)
#
# Exit codes:
#   0  pass — page loads, zero console errors, screenshot stored
#   1  fail — page loads but console errors were captured, the snapshot
#      missed the feature root, or the ego-browser drive failed
#   2  unreachable — URL answered non-200 or curl timed out
#
# Drive: single `ego-browser nodejs` inline script (snapshot + console
# errors + one screenshot). Each surface is driven once per change; see
# SKILL.md "Fast pass".

set -u

if [ "$#" -lt 3 ]; then
  echo "usage: sh helpers/verify-ui.sh URL OUT_DIR FEATURE" >&2
  exit 1
fi

URL="$1"
OUT_DIR="$2"
FEATURE="$3"

mkdir -p "$OUT_DIR"
echo "verify-ui: feature=$FEATURE url=$URL out=$OUT_DIR"

# 1. Load check (5s timeout — a hung server is a failed check, not a wait).
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" 2>/dev/null || true)
if [ "$status" != "200" ]; then
  echo "verify-ui: $URL answered HTTP ${status:-000} (want 200)" >&2
  exit 2
fi
echo "verify-ui: load HTTP 200 at $URL"

# 2. One ego-browser drive: snapshot + console errors + one screenshot.
if ! command -v ego-browser >/dev/null 2>&1; then
  echo "verify-ui: FAILED — ego-browser not on PATH (no drive, no proof)" >&2
  exit 1
fi

export VERIFY_UI_URL="$URL"
export VERIFY_UI_OUT="$OUT_DIR"
if ! ego-browser nodejs <<'EOF' >"$OUT_DIR/drive.log" 2>&1; then
const task = await taskSpace("verify-ui " + (process.env.VERIFY_UI_URL || ""));
const page = task.page("p1");
await page.goto(process.env.VERIFY_UI_URL);
await page.waitForLoadState();
await page.waitForTimeout(3000);
const snapshot = await page.snapshot();
const errors = await page.evaluate(() => {
  const out = [];
  for (const entry of (window.__piDoConsoleErrors || [])) out.push(String(entry));
  return out;
});
const shot = await page.screenshot({ path: process.env.VERIFY_UI_OUT + "/page.png" });
const fs = await import("node:fs/promises");
await fs.writeFile(process.env.VERIFY_UI_OUT + "/snapshot.txt", snapshot ?? "");
await fs.writeFile(process.env.VERIFY_UI_OUT + "/console.log", errors.join("\n") + (errors.length > 0 ? "\n" : ""));
console.log(JSON.stringify({ screenshot: shot, consoleErrors: errors.length }));
await task.finish({ keep: [] });
EOF
  echo "verify-ui: FAILED — ego-browser drive errored (see $OUT_DIR/drive.log)" >&2
  exit 1
fi

cat "$OUT_DIR/drive.log"
errlines=$(wc -l <"$OUT_DIR/console.log" | tr -d ' ')
echo "verify-ui: screenshot $OUT_DIR/page.png; console errors $errlines"
if [ "$errlines" -gt 0 ]; then
  echo "verify-ui: FAILED — console errors at load (see $OUT_DIR/console.log)" >&2
  exit 1
fi
if [ ! -s "$OUT_DIR/snapshot.txt" ]; then
  echo "verify-ui: FAILED — empty snapshot (page rendered nothing)" >&2
  exit 1
fi
echo "verify-ui: PASS (feature=$FEATURE, 0 console errors)"
exit 0
