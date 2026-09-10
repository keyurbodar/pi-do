# Brief C21-PLAN-FLAG: read-only plan mode flag

## GOAL
Add a pure read-only plan mode: a planning flag that blocks every write path, with no approval gate.

## ROLE
Implementer. Bounded session. One owner for this worktree. No subagents, no merge, no user questions.

## SCOPE
Write: `cli` plan flag plus run-path read-only guard, `packages/pi-cf/src/agent/session.ts` hook lines only (one registration line, merged after wt-engine).
Never: engine turn policy, store SQL internals, recovery scan, verify scripts. No approval gate of any kind. No new dependencies, no refactors beyond the flag and guard.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-tools`, base `3ef298b`. Evidence in `verdicts.html` section C item 21.
Item 21 verdict: Plan mode Missing. No planning flag. Only the test stub. This is a pure read-only flag with no approval gate. Approvals are out of scope by root decision. The `session.ts` hook stays one line and merges after wt-engine.

## ACCEPTANCE
- tsc clean in every touched package.
- Plan mode blocks a write with pasted output.
- No approval UI, flag, or stub is added or widened.
- Fast tier 20/20 on your own server.

## VERIFY
`npx tsc --noEmit` in every touched package, then a per-item probe: enable plan mode against your own server and attempt a write, pasting the blocked output. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## ORDER
1 of 3 within `wt-tools`. Predecessor: none.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
