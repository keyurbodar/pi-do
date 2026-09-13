---
name: verify-pi-do
description: Drives pi-do (Cloudflare Workers coding agent) over its HTTP control plane, WS agent stream, and CLI client. Reach for it to prove any pi-do behavior end to end instead of trusting typecheck.
---

# verify-pi-do

Live skill: the app runs from `main` at the v1 cut (PR11 + PR15 + PR26 + PR17
merged). Every Drive recipe below is active. Never claim a drive result for a
recipe you did not run — run Doctor and report the missing prerequisite instead.

## Launch

- Pre-PR01: nothing starts. `helpers/doctor.sh` reports `absent`, which is the
  correct result — do not invent a server.
- From PR01: start the front-door Worker from `worker/`:
  `wrangler dev --port 8787` (port from `worker/wrangler.toml`; if the file
  names another port, use it and record it with the artifacts).
- Ready means `POST {BASE}/workspaces` returns HTTP 200 with a `workspaceId`.
  Poll up to 30s; on timeout treat as failed launch, keep the log, stop.
- One run owns one server: record its PID in `artifacts/{RUN_ID}/server.pid`.
  Concurrent runs use distinct ports and distinct workspace IDs.
- Teardown: kill only the PID in `server.pid`. Never kill by process name.

## Doctor

Run first whenever anything looks off, and before every drive:

`helpers/doctor.sh [BASE_URL]` (default `http://127.0.0.1:8787`).

- Exit `0`: something answers HTTP at BASE (healthy enough to drive).
- Exit `2`: nothing listening (`absent` — expected pre-PR01) or non-HTTP reply.
- Read-only: performs no POST/PUT/WS, creates no workspaces, writes nothing
  outside stdout. Safe against a foreign instance.
- Refuse to drive an instance this run did not start, except a shared dev
  server the user explicitly named (record its URL with the artifacts).

## Drive

Primary harness: the `cli/` client (complete since PR17) plus `curl` for the control
plane. The web app is also a drive target — see "Web surface" below; prefer
stable handles (route paths, frame `type` values, entry cursors, ARIA
labels) over coordinates everywhere.

Conventions:

- `BASE=http://127.0.0.1:8787`, `RUN_ID=verify-$(date +%s)` unless given.
- Isolate by workspace: every run creates its own workspace and seeds only
  `verify-{RUN_ID}/` paths inside it. Never read or write another run's workspace.
- Treat every command in the feature files as literal. Keep route paths,
  frame types, and flags unchanged.
- Drive the real user path: create workspace → seed file → prompt → observe
  tool frames → confirm persisted entries. Internal setters and test-only
  endpoints do not count as proof.

### Web surface

The web app (`frontend/web`, React 19 + rsbuild) is a drive target alongside
the CLI: it is the user's actual surface, so behavior proven only over curl
is not yet proven for the user.

- URL: `http://localhost:3000`. This is the shared dev server the user keeps
  running — never spawn a second instance on port 3000. If a run needs
  isolation (e.g. a build-config change), start the app on a distinct port
  and record it with the artifacts; the shared server stays untouched.
- Readiness: the page loads (HTTP 200) and the browser console shows zero
  errors. A console error at load is a failed launch — capture it, keep the
  log, stop.
- Stable handles: prefer `data-testid` and ARIA labels over CSS classes and
  coordinates. The current app ships few test ids; the stable handles that
  exist today are the layout classes `.shell`, `.thread`, `.composer`, and
  the prompt input `[role="textbox"][aria-label="Ask AI Agent"]` with its
  send/stop button (`aria-label="Send"` / `"Stop"`, `data-status`
  `ready`|`streaming`). Re-check this list against the source before a run;
  never guess selectors.
- Console-error capture is mandatory evidence: every web drive attaches the
  captured console stream (or an explicit "0 errors" record) as
  `artifacts/{RUN_ID}/{feature}/console.log`.
- Screenshot per step: every driving step in a web feature file stores one
  screenshot (`NN-step-name.png`) next to the transcript, so a failure is
  locatable without a re-run.
- One minute per pass: every web verification pass completes in under one
  minute. No re-proving already-verified behavior, no repeated drives of
  unchanged surfaces, no retry loops. One failed check is reported with its
  artifact, not retried endlessly.
- Fast path: `sh helpers/web-check.sh [URL] [OUT_DIR]` — page load, console
  error capture, and screenshot in one headless pass (default URL
  `http://localhost:3000`, default OUT_DIR `artifacts/web-check`). Exit `0`
  pass, `1` console errors/failed run, `2` unreachable, `3` no browser found
  (load check still reported; run console/screenshot through the interactive
  browser harness instead).
- The web app reaches the Worker at `workerBaseUrl()` (default
  `http://127.0.0.1:8787`, override `PUBLIC_WORKER_URL`). Web drives share
  the CLI's BASE; run Doctor first as with any drive.
### Fast pass (one ego-browser drive per surface)

`ego-browser` is the driving harness for every web verification; raw headless-browser flags are a fallback, never the plan. The prebuilt helper `sh helpers/verify-ui.sh URL OUT_DIR FEATURE` runs the whole fast pass in one `ego-browser nodejs` inline drive: curl load check, then snapshot + console-error capture + one screenshot into `OUT_DIR` (`artifacts/{RUN_ID}/{feature}/`). Exit `0` pass (HTTP 200, zero console errors, non-empty snapshot), `1` fail (console errors, empty snapshot, or drive error — see `OUT_DIR/drive.log`), `2` unreachable (non-200/timeout).
Usage: `sh helpers/verify-ui.sh http://localhost:3000 artifacts/{RUN_ID}/web-thread web-thread; echo "exit=$?"`
Time budget: the full fast pass completes in under 60 seconds. A hung load check (5s curl timeout) or a stalled drive is a failed check, not a wait — report it with its artifact and stop.
No duplication: each surface is driven once per change. The fast pass covers load, zero console errors, and one screenshot; the feature recipe then drives only its own new behavior on the already-proven page. The integration pass drives each feature file exactly once — never re-drive a feature another pass already proved, never re-prove verified behavior, no retry loops.

## Evidence

Location: `artifacts/{RUN_ID}/{feature}/` (repo-relative `artifacts/`,
gitignored). Per feature capture:

- `transcript.txt`: every command, its stdout/stderr, and exit code.
- `frames.jsonl`: raw WS stream frames (stream features).
- Second-view proof: re-`GET` the file / entries cursor after the action and
  store the body (`second-view.*`). An action without a second view is incomplete.
- `result.md`: feature ID, entry points used, pass/fail per sub-feature,
  unmet preconditions with the exact failed command.

Proof standards: action plus resulting state (not just the final screen);
side effects verified through a second view (files re-read, entries replayed,
messages observed on the wire); mocks nowhere — the only external boundary is
the LLM provider, recorded as `message_*` frames. A skipped entry point is
reported with its unmet precondition, never as verified-by-another-path.

## Cleanup

- Kill only the PID in `artifacts/{RUN_ID}/server.pid`; remove the pidfile.
- Delete `verify-{RUN_ID}` workspaces via the API when deletion exists,
  otherwise leave the disposable IDs untouched (they isolate by construction).
- Never delete `artifacts/`. After cleanup, list the run's artifact directory
  to confirm the proof survived — a cleanup that eats the proof fails the run.
- Run cleanup after failed iterations too, so broken attempts do not strand
  servers or ports.

## Helpers

- `helpers/doctor.sh [BASE_URL]` — read-only reachability probe. Exit `0`
  listening, `2` absent/unreachable. Usage:
  `sh helpers/doctor.sh http://127.0.0.1:8787; echo "exit=$?"`
- `helpers/web-check.sh [URL] [OUT_DIR]` — web fast path: page load,
  console-error capture, screenshot in one headless pass. Exit `0` pass,
  `1` console errors, `2` unreachable, `3` no browser found. Usage:
  `sh helpers/web-check.sh http://localhost:3000; echo "exit=$?"`
- `helpers/verify-ui.sh URL OUT_DIR FEATURE` — prebuilt fast-pass harness: curl load check, then a single `ego-browser nodejs` inline drive (snapshot + console errors + one screenshot into `OUT_DIR`). Exit `0` pass, `1` fail, `2` unreachable. Usage:
  `sh helpers/verify-ui.sh http://localhost:3000 artifacts/verify-1/web-thread web-thread; echo "exit=$?"`
