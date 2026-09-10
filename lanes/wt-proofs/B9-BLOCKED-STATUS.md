# Brief B9-BLOCKED-STATUS (wt-proofs 1 of 5)

## GOAL
BLOCKED reads as BLOCKED. Quota, keyed, and census scripts exit nonzero-distinct without touching inference, and the suite fails when a required proof is blocked.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: `verify/quota-refusal.sh`, keyed scripts, census script — BLOCKED-status plumbing only.
Never: packages, worker, cli. Behavior of covered code stays untouched.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-proofs`, base `3ef298b`.
Verdicts item B9 (`verdicts.html` B table row 9): "BLOCKED counted as PASS — `verify/quota-refusal.sh`, keyed scripts, census. Green suites that never touched inference prove nothing for months. Report BLOCKED as its own status. Fail the suite if a required proof is blocked."

## ACCEPTANCE
- `sh -n` clean on every touched script.
- A forced-BLOCKED run shows the distinct BLOCKED status with pasted output.
- A suite with a required proof BLOCKED exits red.
- Fast tier 20/20 on your own server after the edits.

## VERIFY
`sh -n` on touched scripts, the forced-BLOCKED probe with pasted output, fast tier 20/20. Own servers only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply (real artifact, pasted receipts, named tier, BLOCKED-is-not-PASS, flakes-proven-not-rerun, deletions-proven, no self-verification).

## TIMEBOX
Mechanical. Ship script by script with receipts.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 1 of 5 within wt-proofs. Same-file predecessor: none.
