# C1 Session root cwd — exec bound with escape rejection

## GOAL
Sessions bind to a project root: create stores `cwd`, exec resolves under it, escapes are rejected with a probe.

## ROLE
Implementer, bounded to this issue only. Own worktree only. No sibling work.

## SCOPE
Write, narrow to C1:
- `packages/pi-cf/src/store/sql-util.ts`: MIGRATIONS plus sessions DDL only — additive `cwd` column on top of the C13 `name` DDL (same DDL file, merges after C13).
- `worker/src/routes/sessions.ts`: create accepts `cwd`, read returns it.
- `worker/src/shell-exec.ts`: cwd binding only — resolve exec under the session root, reject escapes.
Never: name handling beyond keeping C13 intact, fork/lineage, config, doctor, engine turn policy, recovery scan, compaction, context builder, verify scripts. `sql-util.ts` outside MIGRATIONS and sessions DDL belongs to wt-store — do not touch, merge after it.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-schema`, base `3ef298b`.
Verdict `verdicts.html` section C item 1: Session root cwd — Missing — "No cwd column. Exec pins to a fixed workspace root."
Parent lane `lanes/wt-schema.md`: second step after C13 — cwd binding so exec resolves under the session root with escape rejection.

## ACCEPTANCE
- tsc clean in both packages.
- Session create/read round-trip with pasted rows showing `cwd` (plus intact `name`).
- Exec under a bound root rejects escapes with a probe (receipt pasted).
- Fast tier 20/20 on your own server.

## VERIFY
tsc both packages, lifecycle probes, escape probe. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply. No receipt, no done.

## TIMEBOX
Small. Ships with C13 as the first batch with receipts.

## ORDER
Position 2 of 4 within worktree wt-schema. Predecessor that must merge first: C13 (same DDL file, after C13).

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
