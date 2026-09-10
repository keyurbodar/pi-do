# C17 Scoped config plus diagnostics — doctor warns

## GOAL
Config validates at startup with real diagnostics: invalid scoped config warns via doctor instead of failing silent.

## ROLE
Implementer, bounded to this issue only. Own worktree only. No sibling work.

## SCOPE
Write, narrow to C17:
- `worker/src/doctor.ts` plus doctor route: scoped config checks plus startup diagnostics so invalid config warns instead of failing silent.
- Minimal scoped-config validation needed to feed the doctor output; nothing more.
Never: cwd binding, name handling, fork/lineage beyond keeping prior issues intact, engine turn policy, recovery scan, compaction, context builder, verify scripts. `sql-util.ts` outside MIGRATIONS and sessions DDL belongs to wt-store — do not touch; no DDL expected here.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-schema`, base `3ef298b`.
Verdict `verdicts.html` section C item 17: Scoped config plus diagnostics — Partial — "Workspace settings only. Doctor checks liveness alone."
Parent lane `lanes/wt-schema.md`: final step — scoped config plus startup diagnostics so invalid config warns instead of failing silent.

## ACCEPTANCE
- tsc clean in both packages.
- Doctor reports config problems instead of liveness alone (receipt pasted: invalid config in, warning out).
- Valid config stays quiet-green; no behavior change on the happy path.
- Fast tier 20/20 on your own server.

## VERIFY
tsc both packages, doctor probes (valid plus invalid config) on your own server. Skill `skills/verification/SKILL.md` rules 1 to 7 apply. No receipt, no done.

## TIMEBOX
Medium-small. Ships last, after C2, with receipts.

## ORDER
Position 4 of 4 within worktree wt-schema. Predecessor that must merge first: C2.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
