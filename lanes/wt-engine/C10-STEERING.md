# Brief C10: steering queue plus split-abort reconciliation (position 8 of 10)

## GOAL
A single mid-turn steer exists. Add follow-up steering queues and split-abort reconciliation in the turn loop, building on B2's truthful error passthrough.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: the steer region of `worker/src/stream-engine.ts` only — a follow-up queue behind the existing single steer, plus reconciliation when an abort splits the turn.
Never: `turns.ts`, `stream-codec.ts`, `session.ts`, the `shaped()` block (B2), the stub-continue branch (A-STUB-TRIM), store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section C item 10: "Steering queue plus split abort", Partial — one steer per turn, abort yields no reconciliation. Second in the stream-engine chain: B2's shaper truthfulness is assumed, C16's fallback builds on this.

## ACCEPTANCE
- More than one steer per turn is queued and applied in order; a split abort reconciles (no half-applied steer, no silent drop — the outcome is reported).
- B2's passthrough behavior unregressed.
- tsc clean in the worker package.
- Before and after probe with pasted output: before shows the second steer dropped and the split abort silent; after shows ordered application plus reconciliation.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: queue two steers mid-turn, then force a split abort; paste the exact commands plus before/after output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Medium. One sitting. If reconciliation needs scan or store changes, stop and report BLOCKED with the exact missing decision rather than leaking scope.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 8 of 10 within worktree wt-engine. Same-file predecessor: B2 (position 2) must merge first — stream-engine chain order is B2 before C10 before C16. Merges before C16.
