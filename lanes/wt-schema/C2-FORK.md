# C2 Fork plus lineage — fork and clone routes

## GOAL
Sessions fork with lineage: fork/clone routes stamp `parentSessionId` that the context walk can follow.

## ROLE
Implementer, bounded to this issue only. Own worktree only. No sibling work.

## SCOPE
Write, narrow to C2:
- `packages/pi-cf/src/store/sql-util.ts`: MIGRATIONS plus sessions DDL only — additive `parentSessionId` column.
- `worker/src/routes/sessions.ts`: fork and clone routes with lineage.
- `worker/src/routes/turns.ts`: reads only, for fork wiring (no turn policy changes).
Never: cwd binding beyond keeping C1 intact, name handling beyond keeping C13 intact, config, doctor, engine turn policy, recovery scan, compaction, context builder, verify scripts. `sql-util.ts` outside MIGRATIONS and sessions DDL belongs to wt-store — do not touch, merge after it.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-schema`, base `3ef298b`.
Verdict `verdicts.html` section C item 2: Fork plus lineage — Missing — "No parent session, no fork route. Single linear chain only."
Parent lane `lanes/wt-schema.md`: third step — fork and clone routes with lineage that the context walk can follow.

## ACCEPTANCE
- tsc clean in both packages.
- Session create, read, fork round-trip with pasted rows showing `cwd`, `name`, and lineage (`parentSessionId`).
- Fork proof pasted (parent row, child row with parent pointer).
- Fast tier 20/20 on your own server.

## VERIFY
tsc both packages, lifecycle probes, fork proof. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply. No receipt, no done.

## TIMEBOX
Medium-small. Ships after C13 plus C1 with receipts.

## ORDER
Position 3 of 4 within worktree wt-schema. Predecessor that must merge first: C1.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
