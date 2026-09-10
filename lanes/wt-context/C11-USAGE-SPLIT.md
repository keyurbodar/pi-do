# C11 — Usage split by model and cause (3/5, wt-context)

## GOAL
Usage attributes past turns by model (and cause where the rows carry it), instead of sums-only totals.

## ROLE
Implementer, bounded to this issue only.

## SCOPE
Write: `packages/pi-cf/src/store/entries.ts` totals-plus-read regions only — a projection over existing rows (`session_totals`, per-turn `result` bodies via `parseResultUsage`/`sumResultUsage`); no new columns, no migration, no write-path changes.
Never: `entries.ts` write path (belongs to wt-store — merge after it), engine turn policy, session routes, DDL, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-context`, base `3ef298b`.
Verdicts: `verdicts.html` section C item 11 (Usage by model and cause, Partial — "Sums only. No per-model buckets"). Timing-split staging note holds: totals gain no columns in this lane; the live per-turn usage payload is the source of truth.

## ACCEPTANCE
- `tsc` clean in every touched package.
- Usage splits by model with pasted rows (seeded multi-model turns project into per-model buckets that sum back to the totals row).
- No schema change; no write-path change.

## VERIFY
`tsc` in touched packages plus a per-item probe (seed turns, read the projection, paste rows), on your own server only. Skill `skills/verification/SKILL.md` rules 1-7 apply. No formatters, linters, or suites.

## TIMEBOX
Small. Ship after C12 with receipts.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision. (Standing orders `lanes/STANDING.md` item 10, verbatim intent.)

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups. (Standing orders item 9 shape, per shipped batch.)

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness. Own worktree only; shared hook lines merge in ORDER.

## ORDER
Position 3 of 5 within wt-context. Predecessor: C12 must merge first.
