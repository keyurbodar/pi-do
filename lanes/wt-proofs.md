# Lane wt-proofs: honest battery

## GOAL
BLOCKED reads as BLOCKED, timing asserts wait on conditions, the superseded eviction script goes away, and stale docs archive.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: `verify/*` scripts only, plus move `comparison.html` to `docs/archive/`.
Never: packages, worker, cli. Behavior of covered code stays untouched.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-proofs`, base `3ef298b`. Evidence in `verdicts.html` sections A and B items 9, 10, 11.
1. B9. Quota, keyed, and census scripts exit 0 without touching inference. Give BLOCKED a distinct status and fail the suite when a required proof is blocked.
2. B10. `keyed-spark-eviction.sh:18-24` admits its gaps while passing. Label it case-A-only. Eviction claims require sigkill plus soak.
3. B11. Fixed sleeps in cli-proof, compaction-proof, quota-refusal, and soak make color depend on machine speed. Poll explicit conditions with deadlines. Fail on premature completion, never rerun.
4. A-EVICT-DEL. Delete `verify/eviction-repro.sh`. It asserts the pre-scan LOST world. Sigkill plus soak own the contract now.
5. A-DOCS-DEL. Move `comparison.html` to `docs/archive/` with a one-line note. `gaps.html` stays as history. `verdicts.html` is the decision source.

## ACCEPTANCE
- `sh -n` clean on every touched script.
- A forced-BLOCKED run shows the distinct status with pasted output.
- No sleeps without a condition plus a deadline remain in touched scripts.
- eviction-repro gone. comparison archived.
- Fast tier 20/20 on your own server after the edits.

## VERIFY
`sh -n`, the BLOCKED probe, the named suites. Own servers only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Mechanical lane. Ship script by script with receipts.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
