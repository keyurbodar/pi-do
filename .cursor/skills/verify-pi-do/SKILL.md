---
name: verify-pi-do
description: Drives pi-do (Cloudflare Workers coding agent) over its HTTP control plane, WS agent stream, and CLI client. Reach for it to prove any pi-do behavior end to end instead of trusting typecheck.
---

# verify-pi-do

Live skill: the app runs from `main` at the v1 cut (PR11 + PR15 + PR26 + PR17
merged). Every Drive recipe below is active except Extensions (staged for
PR19/PR20). Never claim a drive result for a staged recipe — run Doctor and
report the missing prerequisite instead.

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
plane. No browser harness until the web viewer (PR23); then prefer stable
handles (route paths, frame `type` values, entry cursors) over coordinates.

Conventions:

- `BASE=http://127.0.0.1:8787`, `RUN_ID=verify-$(date +%s)` unless given.
- Isolate by workspace: every run creates its own workspace and seeds only
  `verify-{RUN_ID}/` paths inside it. Never read or write another run's workspace.
- Treat every command in the feature files as literal. Keep route paths,
  frame types, and flags unchanged.
- Drive the real user path: create workspace → seed file → prompt → observe
  tool frames → confirm persisted entries. Internal setters and test-only
  endpoints do not count as proof.

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
