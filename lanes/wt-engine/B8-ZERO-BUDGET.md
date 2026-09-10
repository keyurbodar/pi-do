# Brief B8: honor explicit zero budgets (position 4 of 10)

## GOAL
`packages/pi-cf/src/agent/session.ts:331-339` turns an explicit `maxTurns: 0` into 25. Honor explicit zero; default only the undefined.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: `packages/pi-cf/src/agent/session.ts` lines 331-339 only — the budget defaulting region. Replace the falsy default with an undefined-only default so explicit zero means zero.
Never: `turns.ts`, `stream-engine.ts`, `stream-codec.ts`, other `session.ts` regions (thinking, model, prompt-hook), store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section B item 8: "Zero budget silently becomes 25 turns" at `packages/pi-cf/src/agent/session.ts:331-339` — explicit maxTurns zero runs 25 turns instead of stopping. Fix: honor explicit zero, default only the undefined.

## ACCEPTANCE
- Explicit `maxTurns: 0` stops (zero turns); omitted `maxTurns` still defaults as before.
- tsc clean in `packages/pi-cf`.
- Before and after probe with pasted output: before shows 25 turns on explicit zero; after shows zero turns on explicit zero and unchanged default on undefined.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: run one explicit-zero session and one undefined session, paste the exact commands plus before/after output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Small. One sitting. One-liner expected (`??` over `||` or equivalent); if the defaulting is load-bearing elsewhere, report it as a deviation.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 4 of 10 within worktree wt-engine. Same-file predecessor: none — first in the `session.ts` chain (B8 before C22 before C20 before C9). Merges before C22.
