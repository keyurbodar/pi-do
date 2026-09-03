# pi-do

Serverless coding agent, fully on Cloudflare Workers. No local dependency, 24/7.
One stateless Worker routes; one Durable Object per workspace is the machine
(Workspace + agent harness + session storage, all in DO SQLite).

Self-deployable per user: you bring your own Cloudflare account and keys.
Single-user scale first. No multi-tenant auth/billing, no containers, no
node/python execution in v1.

## What makes pi-do special?

1. **The DO is the machine.** The Worker holds no state; every workspace is one
   DO with its VFS, harness, and session tree in the same SQLite. Crash mid-run
   and the tree is intact.
2. **Persist before emit.** Every harness event is stored before going out on
   the socket. The socket is a view; storage is the truth. Resume is replay.
3. **pi's tools only.** pi's `read/write/edit/bash` against one
   `ComputerExecutionEnv` mapping fs/shell/git onto the Workspace. No porting
   computer's Vercel-format tools.
4. **A library, not a service.** `createPiCf()` embeds the agent in the host's
   own Worker; extensions reuse pi's `ExtensionFactory` (inline now, VFS later).

## A note from Keyur

Small focused PRs over big ones. Working first, extension later. Done means
proven over the real path, not typechecked. Split anything past ~20 minutes.
Lean and boring; fight scope creep, refuse impressive machinery. Fast but never
shortcuts — never trade scalability or production quality for simplicity.

## Glossary

- **you** = the agent reading this. **workspace** = one repo-equivalent (one DO,
  one VFS, many sessions). **session** = one agent conversation + work history.
- **entry** = one persisted session-tree node; the unit of resume. **frame** =
  one WS message; every `entry` frame must also re-read from storage.
- **fence** = owner-token + revision check; stale sockets get `Fenced`/`Conflict`.
- **VFS** = virtual filesystem in DO SQLite. **harness** = pi's agent loop.
  **ExecutionEnv** = pi's fs/shell seam, mapped onto the Workspace.

## File tree (planned end-state)

```
worker/src/            routes/       # workspaces files sessions entries exec git
                       ws/           # stream upgrade, frame encoders
                       index.ts workspace-do.ts   # thin router + DO shell
packages/pi-cf/src/    index.ts      # createPiCf
                       env.ts        # ComputerExecutionEnv (split by area if big)
                       tools.ts extensions.ts
cli/                   bin/pi-do.mjs # arg parsing only
                       lib/          # doctor workspace files session stream output
verify/                *.sh          # one check per behavior
                       fixtures/     # seed data
examples/minimal-agent/              # 30-line L1 embed
```

Rule: no crowded directories — group by area (`routes/`, `ws/`, `lib/`), split
before ~8 files. No file past ~500 lines (hard max 1000); split by area, keep
each file doing one thing. Current `cli/bin/pi-do.mjs` splits into `lib/` next.

## Parallelism

- Parallel by default: fan independent slices to background agents; more agents
  when multiple requests arrive. Assigning work never pauses you — take one
  slice yourself, keep exploring; results interrupt when done.
- Same file needs two changes → one agent, one edit covering both. Never two
  serial edits on one file (plan both, implement once).
- A suggestion contradicting the plan → re-make the plan around the most
  correct implementation. Goal may change; quality never yields to shortcuts.
- No spawn recursion: tell subagents not to spawn their own.

## Verification (behavior, not types)

- `pi-do doctor` first when anything looks off. Read-only, creates nothing.
- Drive with the CLI: `workspace create`, `files put/get/ls`, `entries`,
  `exec`, `git`, `stream`, `commands`. `--json` for machines, exits 0/1/2.
- One `verify/*.sh` per check; each writes `artifacts/{RUN_ID}/{check}/`
  (transcript + frames + second-view re-read).
- Proof = action plus resulting state through a second view. Skipped paths are
  reported, never implied. Never drive a foreign workspace; isolate by fresh
  workspaceId + `verify-*` paths. Skill + map: `.cursor/skills/verify-pi-do/`.
- Scoped checks only: typecheck the touched package, run the one verify script
  for the behavior. Never whole-repo suites per change. A check taking minutes
  means the scope is wrong, not the machine.
- Worktrees ship without node_modules: a typecheck that cannot resolve imports
  proves nothing. Symlink main's worker/node_modules in (remove after) or run
  npm install first; tsc must print nothing, not merely exit.

## PR discipline (every stage)

- `pr.tsv` is the queue. After every PR: set completion % + note in `pr.tsv`
  AND the §10 table in `plan.html`, same turn the work lands.
- Work past ~20 min splits first (`21a/21b/21c` style). Never silently shrink
  scope; no setup-only or test-only PRs; verification rides inside each PR.
- Merge in wave order; within a wave, PR-number order.

## How to work

- Run every task under poteto-mode
  (`/Users/keyur/.agents/skills/poteto-mode/SKILL.md`). Name each principle
  behind a decision and the choice it changed. No citation without a decision.
- Run no-comments (`/Users/keyur/.agents/skills/no-comments/`) before every
  review. Authoring agents defend comments; the sicko does not.

## References (read these, not the world)

- `plan.html` (architecture + §5 protocol + §10 PR table), `pr.tsv` (queue).
- pi contract: `refs/pi/packages/agent/src/harness/{types,agent-harness}.ts`,
  `harness/session/`, `coding-agent/src/core/{extensions/,sdk.ts}`.
- computer shape: `packages/computer/src/{workspace.ts,tools/ai.ts,tools/exec.ts,backends/worker-shell/}`,
  `packages/dofs/src/fs/filesystem.ts` (all under `refs/computer/`).
- durability: `refs/nanocodex/crates/nanocodex-durability/src/store.rs`,
  `refs/nanocodex/docs/DURABILITY.md`.
- Platform: `https://developers.cloudflare.com/workers/llms.txt`.
- Never import from or edit `refs/`. Patterns only.

## Taste

- Existing patterns over new abstractions; delete weightless code.
- One concern per PR. "Also" means split. Errors tell the agent what to do
  instead (`hint` on every JSON error).
- A rule here fighting the task → say so loudly before breaking it.
