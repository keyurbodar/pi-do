# Teammate-layer ship — throughput checkpoint

## Definition of done (falsifiable)
1. `verify/crew-soak.sh` exists, self-boots, and prints `^PASS` with artifacts:
   every routine beat exactly-once, every inbox/group message delivered
   exactly-once (row-level: delivered_at + outcome_cursor set, no lost rows,
   redelivery bounded by kills), per-session cursors gapless, zero open runs.
2. Sessions-list latency measured at realistic scale; optimized only if slow.
3. `tsc --noEmit` clean on worker + packages/pi-cf; `node --test` suites green.
4. Zero grep hits for removed things; docs match reality; fresh worktree boots
   and passes the battery guided by docs alone.
5. Frontend wired to shipped surfaces: bot creation → real sessions, thread
   renders compaction/routineId/inboxIds prompts, meta.contextUsage → meter,
   crew chat over inbox/groups, routines CRUD UI.
6. All web-* verify features pass; group conversation runs live in a browser.

## Rigor: high. Multi-phase, hard gates, user reviews after the fact.

## Units (one PR each, wave order)
- A crew-soak: verify/crew-soak.sh + fixes it surfaces. Worktree crew-soak.
- B backend-gaps: sessions-list perf measure (+optimize iff slow). Worktree backend-gaps.
- C docs-sweep: AGENTS.md, best-of-report closeout, prune stale state. After A+B merge.
- D roster-real: bot creation → POST sessions {name,backstory} + GET sessions hydration.
- E thread-prompts: reducer renders compaction + routineId + inboxIds prompts.
- F usage-meter: meta.contextUsage → meter.
- G crew-chat: group conversation over inbox/groups routes. After D.
- H routines-ui: routines CRUD. After D.

## Seams
- A: verify/ only (+ worker fixes if soak finds bugs — then it owns worker/src too).
- B: worker/src/routes/sessions.ts + verify/ (disjoint filenames from A's new script).
- D: lib/roster.ts, useRosterState.ts, NewBotDialog, session.ts, roster sidebar.
- E: components/thread/{reducer,types}.ts + render components.
- F: composer/meter component + meta fetch. Disjoint from E.
- G,H: after D merges; G touches chat pane + group surfaces, H touches bot sheets.

## Worktree node_modules (per-user standard)
mkdir -p worker/node_modules && cd worker/node_modules &&
for e in /Users/keyur/Documents/pi-do/worker/node_modules/*; do ln -sfn "$e" "$(basename $e)"; done &&
rm -f pi-cf && ln -sfn ../../packages/pi-cf pi-cf
Remove before finishing. Boot dev servers only after this. If assertions fail
weirdly: readlink worker/node_modules/pi-cf first.

## Ports
- :8787 shared worker (main checkout), :3000 shared web (main checkout) — never touch.
- Proofs self-boot: :8794 nightly, :8795 inbox/routines/groups. crew-soak: :8796.
- Frontend agents verify on own ports: web 31xx + worker 87xx pairs, recorded in artifacts.

## Gates
- Per-PR: its verify script PASS (grep ^PASS, not exit code) + scoped tsc.
- Phase 1 gate: crew-soak PASS. Phase 2 gate: timing recorded + suites green.
- Phase 3 gate: zero stale refs + fresh-worktree boot. Phase 4 gate: web-* + live group chat.
