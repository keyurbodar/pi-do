# pi-do verification map

Maintained source for verifying pi-do end to end. Read this index before
driving, then use the matching feature file as the recipe. Every recipe is
staged: the header names the PR that activates it. Staged recipes are not
verified until their PR lands — Doctor decides, not optimism.

## Baseline preconditions

- Start the front-door Worker you own (`wrangler dev`) and record its URL as BASE.
- Set `RUN_ID=verify-$(date +%s)`; create one workspace per run, seed only
  `verify-{RUN_ID}/` paths.
- Put the `cli/` client and `curl` on PATH.
- Run `helpers/doctor.sh BASE` and require exit `0` before any drive.
- Never drive an instance this run did not start.
- Web features drive the shared dev server at `http://localhost:3000` —
  never start a second instance on 3000 (SKILL.md "Web surface").

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer stable handles (route paths, WS frame `type` values, entry cursors) over timing and order assumptions.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Drive the real user path through `curl` and the CLI; internal setters and
  test-only endpoints do not count.
- Restore seeded data after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the action and the resulting state, not only the final frame.
- HTTP proof includes request, status, body, and a second-view re-read.
- Stream proof includes raw `frames.jsonl` plus the persisted `entry` re-read.
- CLI proof includes the command, stdout, stderr, and exit code.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and unmet precondition.
- Never report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph of user-visible
behavior, then exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line per behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with pi-do CLI` (API/CLI features) or `Driving it in the
   browser` (web features) starts with `Preconditions:` and pairs each user
   action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Workspaces and files](./workspaces-files.md) — create workspace, seed/read files. Activates PR01/PR02.
- [Sessions and entries](./sessions-entries.md) — session lifecycle, entries replay, resume. Activates PR07/PR09.
- [Exec and git](./exec-git.md) — one-off shell, narrow git ops, allowlist rejection. Activates PR04/PR05.
- [Agent stream](./agent-stream.md) — prompt/steer/abort over WS, fence conflicts. Activates PR10.
- [Models and thinking](./models.md) — catalog, session switches, one-shot overrides, workspace defaults. Activates PR24/PR25/PR26.
- [Compaction](./compaction.md) — auto mark-then-archive, manual compact route, archive re-read. Activates PR48a-c.
- [Routines](./routines.md) — scheduled durable turns: once/interval/weekly, expiry, caps, exactly-once claim, restart resilience. Activates PR54.
- [Web thread](./web-thread.md) — chat thread in the browser: bootstrap, send, stream, settle. Live with the web frontend (shared dev server).
- [Web roster](./web-roster.md) — bot roster sidebar: view/search/pin/delete, create bot/group/section, icon rail, select bot. Live with the web frontend (shared dev server).
- [Web composer](./web-composer.md) — prompt composer: type, send/stop states, abort while running. Live with the web frontend (shared dev server).
