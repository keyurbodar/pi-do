# C23 — Entry write validation

## GOAL
Entries write path rejects corruption with a named error, never coerces.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: new validation module plus one hook line in `appendEntry` covering JSON-serializability, duplicate ids, sequence and lane-leaf chaining.
Narrow to item 23 only. Never: checkpoints/rewind/branch summaries (C6), engine turn policy, compaction, context builder, verify scripts. The `entries.ts` hook merges after wt-store.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-branch`, base `3ef298b`. Evidence in `verdicts.html` sections B and C item 23.

## ACCEPTANCE
- tsc clean in both packages.
- Each validation class rejects with pasted output.
- Fast tier 20/20 on your own server.

## VERIFY
tsc plus rejection probes on your own server, one pasted rejection per validation class. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Ship after C6 with receipts.

## ORDER
Position 2 of 2 within this worktree. Predecessor: C6 (must merge first; the `entries.ts` hook merges after wt-store).

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
