# Brief A-EVICT-DEL (wt-proofs 3 of 5)

## GOAL
The superseded eviction script goes away. Delete `verify/eviction-repro.sh`; sigkill plus soak own the contract now.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Delete: `verify/eviction-repro.sh` only.
Never: packages, worker, cli. Behavior of covered code stays untouched.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-proofs`, base `3ef298b`.
Verdicts item A (`verdicts.html` A table, eviction-repro.sh row): DELETE — "Asserts the pre-scan LOST world. Superseded by sigkill plus soak. Rewrite or remove."

## ACCEPTANCE
- `verify/eviction-repro.sh` gone; exact non-move list shown.
- `sh -n` clean on every touched script (none expected besides the deletion).
- Fast tier 20/20 on your own server after the cut.

## VERIFY
Tier green after the cut plus the exact non-move list, fast tier 20/20. Own servers only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply (rule 6: deletions get proof too).

## TIMEBOX
Mechanical. Delete, prove green, report.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 3 of 5 within wt-proofs. Same-file predecessor: none (distinct file; no overlap with B9/B10/B11 scripts).
