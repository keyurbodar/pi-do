# Brief C22: harness retry, stream, and execution settings (position 5 of 10)

## GOAL
Budgets are plumbed but there is no retry policy, no stream options, and no parallel-versus-sequential knob. Add the harness retry policy, stream options, and the parallel/sequential toggle in the `session.ts` budgets region.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: `packages/pi-cf/src/agent/session.ts` budgets region only — retry policy, stream options, parallel-versus-sequential knob. Smallest settings shape that the turn path can read.
Never: `turns.ts`, `stream-engine.ts`, `stream-codec.ts`, thinking/model/prompt-hook regions of `session.ts`, store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section C item 22: "Retry, stream, tool-execution settings", Partial — budgets plumbed, no retry policy, no stream options, no parallel toggle. Depends on B8's zero-honoring defaults in the same region.

## ACCEPTANCE
- Retry policy, stream options, and a parallel/sequential knob exist as session settings with sane defaults and are readable by the turn path.
- Explicit zero budgets from B8 still honored (no regression).
- tsc clean in `packages/pi-cf`.
- Before and after probe with pasted output: before shows the settings absent; after shows them set, defaulted, and read back.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: set each knob, read it back through the turn path, paste the exact commands plus output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Medium. One sitting. If the settings shape wants a new module or framework, shrink to one-liner fields on the existing budgets object and report the cut as a deviation.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 5 of 10 within worktree wt-engine. Same-file predecessor: B8 (position 4) must merge first — same `session.ts` budgets region. Merges before C20.
