# Brief B11-CONDITION-POLLS (wt-proofs 4 of 5)

## GOAL
Timing asserts wait on conditions, not machine speed. Fixed sleeps in cli-proof, compaction-proof, quota-refusal, and soak become explicit-condition polls with deadlines; premature completion fails, never reruns.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: `verify/` cli-proof, compaction-proof, quota-refusal, and soak scripts — sleep-to-poll conversion only.
Never: packages, worker, cli. Behavior of covered code stays untouched.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-proofs`, base `3ef298b`.
Verdicts item B11 (`verdicts.html` B table row 11): "Sleep-poll assertions — `cli-proof, compaction-proof, quota-refusal, soak`. Red and green depend on machine speed, not behavior. Poll on explicit conditions with deadlines. Fail, do not rerun, on premature completion."

## ACCEPTANCE
- `sh -n` clean on every touched script.
- No sleeps without a condition plus a deadline remain in touched scripts.
- Premature completion fails the run; nothing reruns to green.
- Fast tier 20/20 on your own server after the edits.

## VERIFY
`sh -n` on touched scripts, a poll-behavior run with pasted output, fast tier 20/20. Own servers only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply (rule 5: flakes get proven, not rerun).

## TIMEBOX
Mechanical. Ship script by script with receipts.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 4 of 5 within wt-proofs. Same-file predecessor: B9-BLOCKED-STATUS (quota-refusal overlap; merge B9 first).
