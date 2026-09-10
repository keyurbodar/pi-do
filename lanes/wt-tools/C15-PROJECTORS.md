# Brief C15-PROJECTORS: custom entry projector registry

## GOAL
Turn the fixed `ENTRY_PROJECTION` table into a registry for custom entry projectors so unknown types stop landing in skipped.

## ROLE
Implementer. Bounded session. One owner for this worktree. No subagents, no merge, no user questions.

## SCOPE
Write: new projector registry module plus `ENTRY_PROJECTION` hookup, `packages/pi-cf/src/agent/session.ts` hook lines only (one registration line, merged after wt-engine).
Never: engine turn policy, store SQL internals, recovery scan, verify scripts. No new dependencies, no refactors beyond the registry and its hookup.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-tools`, base `3ef298b`. Evidence in `verdicts.html` section C item 15.
Item 15 verdict: Custom entries plus projectors Missing. Fixed projection table. Unknown types are skipped. The fixed 6-key `ENTRY_PROJECTION` (`sql-util.ts:211-218`) becomes a registry; a registered projector projects, unregistered types keep old behavior. The `session.ts` hook stays one line and merges after wt-engine.

## ACCEPTANCE
- tsc clean in every touched package.
- A registered projector projects with pasted output.
- Unregistered types keep old behavior.
- Fast tier 20/20 on your own server.

## VERIFY
`npx tsc --noEmit` in every touched package, then a per-item probe: register a projector against your own server and show a projected entry plus an unregistered type with old behavior, pasting both outputs. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## ORDER
2 of 3 within `wt-tools`. Predecessor: C21-PLAN-FLAG, which must merge first.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
