# Brief A-DOCS-ARCHIVE (wt-proofs 5 of 5)

## GOAL
Stale docs archive. `comparison.html` moves to `docs/archive/` with a one-line note; `gaps.html` stays as history; `verdicts.html` is the decision source.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Move: `comparison.html` to `docs/archive/` plus a one-line note. Nothing else.
Never: packages, worker, cli, `verify/` scripts. Behavior of covered code stays untouched.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-proofs`, base `3ef298b`.
Verdicts item A (`verdicts.html` A table, comparison/gaps row, plus footer): DELETE — "Comparison is stale. Gaps stays as history, not as a verdict source. This file replaces both for decisions." Footer: "Supersedes comparison.html and gaps.html for decisions. Those stay as history."

## ACCEPTANCE
- `comparison.html` archived under `docs/archive/` with a one-line note.
- `gaps.html` untouched as history.
- Fast tier 20/20 on your own server after the move.

## VERIFY
Tier green after the move plus the exact non-move list, fast tier 20/20. Own servers only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply (rule 6: deletions/moves get proof too).

## TIMEBOX
Mechanical. Move, note, prove green.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 5 of 5 within wt-proofs. Same-file predecessor: none (docs-only; no overlap with verify scripts).
