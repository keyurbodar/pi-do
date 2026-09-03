# Exec and git

Activates PR04 (one-off shell) / PR05 (narrow git). A user runs a single shell
command outside the agent loop and performs git reads without shell-quoting
footguns.

## Sub-features

- `exec-once` runs one command via `POST /workspaces/{id}/exec` and returns output.
- `git-read` runs allowlisted git reads via `POST .../sessions/{sid}/git`.
- `git-reject` refuses off-allowlist argv before execution: unknown/networked argv → 403, deferred local writes → 501.

## How to get to it (user POV)

- `POST {BASE}/workspaces/{id}/exec` with `{ "command": "echo hi" }`.
- `POST {BASE}/workspaces/{id}/sessions/{sid}/git` with `{ "argv": ["status"] }`.
- Same git route with `{ "argv": ["push", "origin", "main"] }` for the rejection path.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS exists; a session SID exists for the git route.

- **One-off exec.** Run `echo`. Run
  `curl -s -X POST {BASE}/workspaces/{WS}/exec -H 'Content-Type: application/json' --data '{"command":"echo hi-verify"}'`.
  Stdout contains `hi-verify` with exit code `0` in the body.
- **Git status.** Run status through the git route. Run
  `curl -s -X POST {BASE}/workspaces/{WS}/sessions/{SID}/git -H 'Content-Type: application/json' --data '{"argv":["status"]}'`.
  The response is HTTP 200 with status output, not shell text.
- **Allowlist rejection.** Attempt a networked op. Run the same route with
  `'{"argv":["push","origin","main"]}'`. The response is 403 and nothing
  executes. Attempt a deferred local write with `'{"argv":["add","."]}'`;
  the response is 501. Any execution on either path fails the run.
- **Proof.** Store all four bodies plus `transcript.txt` in
  `artifacts/{RUN_ID}/exec-git/`.

## Gotchas

- The git route takes argv arrays, never command strings; a string form is a bug.
- Exec runs outside the agent loop: no entries may appear for it.
- just-bash has no node/python; attempting them proves the sandbox, not a failure.
- Exec past 10s returns 408 with a timed-out body; output caps at 1MiB.
