# C5 — Token compaction trigger (1/5, wt-context)

## GOAL
Compaction fires on token pressure, not pure entry-count math.

## ROLE
Implementer, bounded to this issue only.

## SCOPE
Write: `worker/src/compaction.ts` trigger path only (`shouldCompact`, `LIVE_ENTRY_BUDGET` / `COMPACTION_RESERVE` count math at lines 25-27 becomes a token-window check, using the existing `estimateTokens` convention in `packages/pi-cf/src/agent/context.ts`).
Never: summary text (`summarizePrefix`), engine turn policy, session routes, DDL, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-context`, base `3ef298b`.
Verdicts: `verdicts.html` section C item 5 (Token compaction trigger, Partial — "Trigger is pure count math. Token view is post-hoc").

## ACCEPTANCE
- `tsc` clean in every touched package.
- Compaction fires on token pressure with a before-and-after probe (token estimate above window compacts; below window does not).
- `verify/token-window.sh` green on your own server.

## VERIFY
`tsc` in touched packages plus `verify/token-window.sh` plus the before/after probe, on your own server only. Skill `skills/verification/SKILL.md` rules 1-7 apply. No formatters, linters, or suites.

## TIMEBOX
Small. Ship first with receipts; C12 builds on this file.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision. (Standing orders `lanes/STANDING.md` item 10, verbatim intent.)

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups. (Standing orders item 9 shape, per shipped batch.)

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness. Own worktree only; shared hook lines merge in ORDER.

## ORDER
Position 1 of 5 within wt-context. Predecessor: none.
