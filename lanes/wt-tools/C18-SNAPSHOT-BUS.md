# Brief C18-SNAPSHOT-BUS: watchable session snapshot bus

## GOAL
Add a watchable session snapshot bus: run start and end events plus a snapshot endpoint next to the point-read meta.

## ROLE
Implementer. Bounded session. One owner for this worktree. No subagents, no merge, no user questions.

## SCOPE
Write: new snapshot bus module plus watchable snapshot endpoint, `packages/pi-cf/src/agent/session.ts` hook lines only (one registration line, merged after wt-engine).
Never: engine turn policy, store SQL internals, recovery scan, verify scripts. No new dependencies, no refactors beyond the bus and its endpoint.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-tools`, base `3ef298b`. Evidence in `verdicts.html` section C item 18.
Item 18 verdict: Events plus snapshot watches Missing. Frames stream. No watchable snapshot bus. This adds the run start and end bus plus a watchable snapshot endpoint next to the point-read meta. The `session.ts` hook stays one line and merges after wt-engine.

## ACCEPTANCE
- tsc clean in every touched package.
- A watcher observes run start, snapshot, and run end with pasted frames.
- Fast tier 20/20 on your own server.

## VERIFY
`npx tsc --noEmit` in every touched package, then a per-item probe: attach a watcher against your own server and paste the run-start, snapshot, and run-end frames. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## ORDER
3 of 3 within `wt-tools`. Predecessor: C15-PROJECTORS, which must merge first.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
