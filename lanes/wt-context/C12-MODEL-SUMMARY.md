# C12 — Model-grade compaction summary (2/5, wt-context)

## GOAL
The compaction summary reads model-grade, not mechanical first-lines.

## ROLE
Implementer, bounded to this issue only.

## SCOPE
Write: `worker/src/compaction.ts` `summarizePrefix` only (lines 103-132: first-line-per-entry join plus `Math.ceil(chars/4)` post-hoc token math becomes a model-grade summary; keep the turn-boundary cut, archive pages, and summary-entry shape unchanged).
Never: trigger thresholds (C5 owns them), engine turn policy, session routes, DDL, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-context`, base `3ef298b`.
Verdicts: `verdicts.html` section C item 12 (Compaction-aware context, Partial — "Window cut exists. Summary is mechanical, not model-grade"). Same file as C5; implement on top of merged C5.

## ACCEPTANCE
- `tsc` clean in every touched package.
- A compacted prefix yields a summary that reads as a model-grade synthesis of the archived entries, not `compacted N entries ... type#cursor: first-line` joins.
- `verify/compaction-proof.sh` green on your own server.

## VERIFY
`tsc` in touched packages plus `verify/compaction-proof.sh` plus a before/after probe (compact a seeded prefix, read the summary entry), on your own server only. Skill `skills/verification/SKILL.md` rules 1-7 apply. No formatters, linters, or suites.

## TIMEBOX
Small. Ship with C5 with receipts before C11/C4/C14.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision. (Standing orders `lanes/STANDING.md` item 10, verbatim intent.)

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups. (Standing orders item 9 shape, per shipped batch.)

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness. Own worktree only; shared hook lines merge in ORDER.

## ORDER
Position 2 of 5 within wt-context. Predecessor: C5 must merge first (same `compaction.ts`).
