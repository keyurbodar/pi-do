# Brief B10-EVICTION-LABEL (wt-proofs 2 of 5)

## GOAL
The known-incomplete eviction script stops passing as general proof. Label it case-A-only; eviction claims require sigkill plus soak.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: `verify/keyed-spark-eviction.sh` header/label only (the gaps admitted at lines 18-24 become a case-A-only label).
Never: packages, worker, cli. Behavior of covered code stays untouched.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-proofs`, base `3ef298b`.
Verdicts item B10 (`verdicts.html` B table row 10): "Eviction script ships known-incomplete — `verify/keyed-spark-eviction.sh:18-24`. Header admits the gaps while the script passes as proof. Mark it case-A-only. Require sigkill plus soak for eviction claims."

## ACCEPTANCE
- `sh -n` clean on the touched script.
- Script output/claims read case-A-only; nothing in it presents as general eviction proof.
- Fast tier 20/20 on your own server after the edit.

## VERIFY
`sh -n` on the script, a run showing the case-A-only label with pasted output, fast tier 20/20. Own servers only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Mechanical. One label, one receipt.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 2 of 5 within wt-proofs. Same-file predecessor: B9-BLOCKED-STATUS (keyed-script overlap; merge B9 first).
