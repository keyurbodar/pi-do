# Lane wt-schema: sessions gain root, name, lineage, config

## GOAL
Sessions bind to a project root, carry a human name, fork with lineage, and validate config at startup with real diagnostics.

## ROLE
Owner. Coupled multi-step session. One owner for this worktree.

## SCOPE
Write: `packages/pi-cf/src/store/sql-util.ts` (MIGRATIONS plus sessions DDL only), `worker/src/routes/sessions.ts`, `worker/src/shell-exec.ts` (cwd binding only), `worker/src/routes/turns.ts` reads only for fork wiring, `worker/src/doctor.ts` plus doctor route.
Never: engine turn policy, recovery scan, compaction, context builder, verify scripts. `sql-util.ts` outside MIGRATIONS and sessions DDL belongs to wt-store; merge after it.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-schema`, base `3ef298b`. Evidence in `verdicts.html` section C items 1, 2, 13, 17.
Data shape first. Extend the session record with `cwd`, `name`, and `parentSessionId` via additive migrations. Then, in order: C13 name create plus read, C1 cwd binding so exec resolves under the session root with escape rejection, C2 fork and clone routes with lineage that the context walk can follow, C17 scoped config plus startup diagnostics so invalid config warns instead of failing silent.

## ACCEPTANCE
- tsc clean in both packages.
- Session create, read, fork round-trip with pasted rows showing cwd, name, and lineage.
- Exec under a bound root rejects escapes with a probe.
- Doctor reports config problems instead of liveness alone.
- Fast tier 20/20 on your own server.

## VERIFY
tsc both packages, lifecycle probes, fork proof, escape probe. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Large lane. Ship C13 plus C1 first with receipts, then C2, then C17.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape, per shipped batch.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
