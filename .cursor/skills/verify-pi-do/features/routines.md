# Routines (scheduled turns)

Activates the Routines feature (scheduled durable turns, PR54). A user
schedules a prompt to fire once, on an interval, or weekly into an existing
session; the DO alarm claims each routine exactly once per beat (SQL CAS on
`claim_epoch`), enqueues the prompt into the session's normal turn pipeline,
and the fired turn shows up as a persisted prompt entry carrying `routineId`.
Missed beats consume one overdue run, never a burst. The canonical
implementation proof is `verify/routines-proof.sh` (7 scenarios); this file
drives the same behavior the way a user does.

## Sub-features

- `routine-create` schedules a prompt (once / interval / weekly) on a session and returns a routine id.
- `routine-list` lists the session's routines with schedule, `nextRunAt`, `runCount`, `active`.
- `routine-delete` removes one routine; no further fire happens after the delete.
- `fire-once` fires exactly once at the due time; the fired turn appears as a prompt entry carrying `routineId`.
- `restart-resilience` a server restart mid-wait still produces exactly one fire.
- `no-burst` an overdue routine consumes exactly one run (no catch-up for older missed beats).
- `expiry` a routine past `expire_at` deactivates (`active: false`) and stops firing; the row is kept.
- `caps` creation past 50 active routines per workspace is rejected with 409 `{error, hint}`; intervals below 60s rejected with 400 `{error, hint}`.

## How to get to it (user POV)

- `POST {BASE}/workspaces/{id}/sessions/{sid}/routines` with the schedule and prompt.
- `GET {BASE}/workspaces/{id}/sessions/{sid}/routines` to list (session-scoped).
- `DELETE {BASE}/workspaces/{id}/sessions/{sid}/routines?id={RID}` to cancel.
- `cli routines create --ws WS --sid SID --kind once|interval|weekly --spec S --prompt T [--expire-at ISO] [--max-runs N] [--request-id R] --json`
- `cli routines list --ws WS --sid SID --json`; `cli routines delete --ws WS --sid SID --id RID --json`
- Spec syntax: ISO timestamp (once), seconds >= 60 (interval), `weekday:HH:MM` like `mon:09:30` (weekly). Create stdout: `routine <id> next=<iso>`; with `--json` the id is `.routine.id`.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS and a session SID exist (sessions-entries recipe).
- The stub model is fine: a fired routine runs a real turn, so keyless the
  proof covers scheduling/claiming/marker-entry, never model quality.

- **Create.** Schedule a once routine ~90s out:
  `cli routines create --ws {WS} --sid {SID} --kind once --spec "{ISO}" --prompt "write verify-{RUN_ID}/routine.txt containing fired" --json`
  HTTP 200 with `.routine.id`; store it as RID. `cli routines list --json`
  shows the routine with `nextRunAt` and `runCount: 0` — the list is the
  first view.
- **Reject bad create.** `--kind interval --spec 30` is rejected with
  `{error, hint}`; creating the 51st active routine is rejected with 409
  `{error, hint}`. State unchanged either way.
- **Fire on time + fire-once.** Wait until `nextRunAt` plus slack
  (`sh helpers/wait-routine.sh {BASE} {WS} {SID} {RID} {CURSOR} 180`) then
  re-read entries:
  `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/entries?after={CURSOR}"`.
  Exactly one new prompt entry carries `"routineId":"{RID}"`. A second wait
  of the same length adds no second turn — once means once.
- **Second-view proof.** The fired turn's file write is re-read byte-level:
  `curl -s "{BASE}/workspaces/{WS}/files?path=verify-{RUN_ID}/routine.txt"`.
  Body contains `fired`. The entry re-read above is the persistence view;
  neither alone is proof.
- **Delete cancels.** Create a second once routine, delete it before it is
  due (`cli routines delete --ws {WS} --sid {SID} --id {RID2} --json`),
  wait past its `nextRunAt`, and re-read entries: no turn for RID2. `list`
  no longer shows it (delete is a removal; only expiry keeps the row, as
  `active: false`).
- **Restart mid-wait.** Record the dev-server PID
  (`artifacts/{RUN_ID}/server.pid`), schedule a once routine ~60s out, kill
  the recorded PID, relaunch `wrangler dev` on the SAME port, update
  `server.pid`, and wait with the helper. Exactly one fired turn appears.
  Two fires or zero fires both fail the run.
- **No burst.** Schedule an interval routine (120s), let it fire once, then
  pause the server (kill; keep the routine overdue by >2 intervals), relaunch,
  and wait. Exactly one new turn appears after restart — the missed beats
  collapse to one, never N.
- **Expiry.** Create with `--expire-at` in the near past (accepted at
  create). After the beat, `list` shows `active: false` and no turn fires
  (`runCount` stays 0).
- **Claim race.** Schedule two due-now routines on two fresh sessions so two
  alarm ticks land near-simultaneously. Still exactly one turn per routine —
  the SQL CAS on `claim_epoch` makes double-pokes safe; this is a safety
  proof, not the primary entry point.
- **Proof.** Store create/list/delete bodies, the entries re-reads, the file
  second view, the restart transcript (old PID, kill, relaunch, new PID),
  and `transcript.txt` in `artifacts/{RUN_ID}/routines/`.

## Gotchas

- The fired turn is a normal turn: it consumes the session's one-turn-at-a-time
  queue (PR11). A busy session delays the routine's turn; the delay is not a
  missed fire. Check `runCount` before declaring a fire late.
- Wait for the fire by polling entries with a cursor, never by sleeping a
  fixed time and asserting — CI drift eats fixed sleeps. `helpers/wait-routine.sh`
  exists for this; use it instead of a bare `sleep`.
- The create JSON nests the id: `.routine.id`, not `.id`. Create without
  `--json` prints `routine <id> next=<iso>`.
- The restart scenario needs recorded-PID discipline: kill only the PID in
  `server.pid`, relaunch on the same port, and rewrite the pidfile. Killing by
  name can eat unrelated dev servers.
- The alarm claim is a SQL CAS on `claim_epoch`: manually poking the alarm
  twice cannot double-fire. Do not "fix" a missed fire by poking harder —
  a zero-fire is a real failure, find the actual cause.
- The claim does not prove the turn ran. The proof is the persisted entry
  with `routineId` plus the file second view; an alarm log line alone
  fails the run.
- Expiry vs delete: a deleted routine and an expired routine both stop
  firing, but only one is a removal. Assert via `list` state, not via
  absence of fire alone (absence is also what a broken alarm looks like).
- Proof artifacts for the restart scenarios must include the recorded PID
  and the relaunch transcript, or the exactly-once claim is unfalsifiable.
- Weekly fires have no e2e proof (a 7-day clock); weekly parsing and
  next-run computation are covered in `worker/test/routines.test.mjs`.
