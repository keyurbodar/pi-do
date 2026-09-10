# Brief C20: use the derived thinking value (position 6 of 10)

## GOAL
The turn path uses requested thinking (`packages/pi-cf/src/agent/session.ts:216`), not the derived value. Switch the turn path to the derived one.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: `packages/pi-cf/src/agent/session.ts` around line 216 only — the turn-path read of the thinking level. Use the derived value where the requested value is currently read.
Never: `turns.ts`, `stream-engine.ts`, `stream-codec.ts`, budgets/model/prompt-hook regions of `session.ts`, store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section C item 20: "Thinking derivation", Partial — level persisted and derived into context, but the turn path ignores it. Depends on the `session.ts` chain (B8, then C22) merging first so the surrounding regions are stable.

## ACCEPTANCE
- The turn path consumes the derived thinking value; setting a derivation input changes turn behavior while the requested value alone does not.
- tsc clean in `packages/pi-cf`.
- Before and after probe with pasted output: before shows the turn using the requested value despite derivation; after shows the derived value driving the turn.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: run one turn with derivation set and requested unset/divergent, paste the exact commands plus before/after output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Small. One sitting. One-liner expected; if the derived value is not in scope at line 216, report BLOCKED with the exact missing plumbing rather than threading new state.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 6 of 10 within worktree wt-engine. Same-file predecessor: C22 (position 5) must merge first — `session.ts` chain order is B8 before C22 before C20 before C9. Merges before C9.
