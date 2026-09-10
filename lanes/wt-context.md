# Lane wt-context: token-aware memory plus project context

## GOAL
Compaction triggers on tokens with model-grade summaries, usage attributes by model and cause, and sessions load project context plus read branches.

## ROLE
Owner. Coupled multi-step session. One owner for this worktree.

## SCOPE
Write: `worker/src/compaction.ts`, `packages/pi-cf/src/agent/context.ts`, `packages/pi-cf/src/store/entries.ts` (totals plus read regions only), new project-context loader file, new branch-read code in `context.ts`.
Never: engine turn policy, session routes, DDL, verify scripts. `entries.ts` write path belongs to wt-store; merge after it.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-context`, base `3ef298b`. Evidence in `verdicts.html` sections A and C items 5, 11, 12, 4, 14.
Contracts from wt-schema, which you cannot see: read `cwd` with `SELECT cwd FROM sessions WHERE sid = ?`. Read lineage with `SELECT parentSessionId FROM sessions WHERE sid = ?`. If either column is absent, return BLOCKED naming the column, do not invent it.
Order: C5 token trigger (`compaction.ts:25-27` count math becomes token-window), C12 model summary replacing mechanical first-lines (`compaction.ts:103-132`), C11 usage attribution as a projection over existing rows, C4 project context files loaded under the session root, C14 branch-scoped reads over the lineage chain.

## ACCEPTANCE
- tsc clean in both packages.
- Compaction fires on token pressure with a before and after probe.
- A summary reads model-grade, not first-lines.
- Usage splits by model with pasted rows.
- Context files load from the bound root. Branch reads walk lineage.
- `verify/compaction-proof.sh` and `verify/token-window.sh` green on your own server.

## VERIFY
tsc plus the two named scripts plus per-item probes. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Large lane. Ship C5 plus C12 first with receipts, then the rest in order.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape, per shipped batch.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
