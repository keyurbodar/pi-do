# C13 Session name — create plus read

## GOAL
Add a human name to the session record: create accepts it, read returns it, rows prove it.

## ROLE
Implementer, bounded to this issue only. Own worktree only. No sibling work.

## SCOPE
Write, narrow to C13:
- `packages/pi-cf/src/store/sql-util.ts`: MIGRATIONS plus sessions DDL only — additive `name` column (nullable text, no backfill semantics beyond default null).
- `worker/src/routes/sessions.ts`: create accepts optional `name`, read returns it.
Never: cwd binding, fork/lineage, config, doctor, engine turn policy, recovery scan, compaction, context builder, verify scripts. `sql-util.ts` outside MIGRATIONS and sessions DDL belongs to wt-store — do not touch, merge after it.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-schema`, base `3ef298b`.
Verdict `verdicts.html` section C item 13: Session name — Missing — "No label column anywhere."
Parent lane `lanes/wt-schema.md`: data shape first; this issue is the first DDL step (name create plus read).

## ACCEPTANCE
- tsc clean in both packages.
- Session create with `name`, read back same row showing `name`, pasted rows as receipt.
- Missing `name` stays null, never errors.
- Fast tier 20/20 on your own server.

## VERIFY
tsc both packages, then create/read lifecycle probes against your own server with pasted rows. Skill `skills/verification/SKILL.md` rules 1 to 7 apply. No receipt, no done.

## TIMEBOX
Small. Ship C13 first with receipts before C1 builds on its DDL.

## ORDER
Position 1 of 4 within worktree wt-schema. Predecessor that must merge first: none.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
