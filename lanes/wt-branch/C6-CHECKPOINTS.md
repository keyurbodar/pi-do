# C6 — Checkpoints, rewind, branch summaries

## GOAL
Checkpoints the agent can rewind to, with branch summaries over the lineage chain.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: new checkpoint module plus routes, rewind to a checkpoint, branch-summary entry support reading the lineage chain.
Narrow to item 6 only. Never: entry validation (C23), engine turn policy, compaction, context builder, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-branch`, base `3ef298b`. Evidence in `verdicts.html` sections B and C item 6.
Contract from wt-schema, which you cannot see: lineage reads `SELECT parentSessionId FROM sessions WHERE sid = ?`. If the column is absent, return BLOCKED naming the column, do not invent it.

## ACCEPTANCE
- tsc clean in both packages.
- Checkpoint, rewind, and branch summary round-trip with pasted rows.
- Fast tier 20/20 on your own server.

## VERIFY
tsc plus round-trip with pasted rows on your own server. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Ship with receipts before C23 starts.

## ORDER
Position 1 of 2 within this worktree. Predecessor: none.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
