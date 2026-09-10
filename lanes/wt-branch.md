# Lane wt-branch: rewind plus write validation

## GOAL
Checkpoints the agent can rewind to, with branch summaries, and an entries write path that rejects corruption.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: new checkpoint module plus routes, branch-summary entry support, new validation module plus one hook line in `appendEntry`.
Never: engine turn policy, compaction, context builder, verify scripts. The `entries.ts` hook merges after wt-store.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-branch`, base `3ef298b`. Evidence in `verdicts.html` sections B and C items 6 and 23.
Contract from wt-schema, which you cannot see: lineage reads `SELECT parentSessionId FROM sessions WHERE sid = ?`. If the column is absent, return BLOCKED naming the column, do not invent it.
C6 first. Checkpoints plus rewind plus branch summaries over the lineage chain. Then C23. Validation taxonomy on the write path: JSON-serializability, duplicate ids, sequence and lane-leaf chaining. Reject with a named error, never coerce.

## ACCEPTANCE
- tsc clean in both packages.
- Checkpoint, rewind, and branch summary round-trip with pasted rows.
- Each validation class rejects with pasted output.
- Fast tier 20/20 on your own server.

## VERIFY
tsc plus round-trip plus rejection probes. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Ship C6 first with receipts, then C23.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
