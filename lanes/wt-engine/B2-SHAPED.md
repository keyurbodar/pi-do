# Brief B2: pass errors through the shaper (position 2 of 10)

## GOAL
`shaped()` (`worker/src/stream-engine.ts:251-255`) truncates every error at 300 chars and invents model errors. Pass through message plus cause; shape known 404s only.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: `worker/src/stream-engine.ts` lines 251-255 only — the `shaped()` body. Pass through the original message plus cause; keep shaping for known 404s.
Never: `turns.ts`, `stream-codec.ts`, `session.ts`, store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section B item 2: "Error shaper truncates and invents strings" at `worker/src/stream-engine.ts:251-255` — every unknown throw becomes retry-with-catalog-model, cut at 300 chars. Fix: pass through message plus cause, shape known 404s only.

## ACCEPTANCE
- Unknown throws keep their full message plus cause; no 300-char truncation, no invented retry-with-catalog-model string.
- Known 404s still get their existing shape.
- tsc clean in the worker package.
- Before and after probe with pasted output: before shows a long unknown error truncated to 300 chars with the invented string; after shows the full passthrough.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: throw one unknown error and one known 404, paste the exact commands plus before/after output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Small. One sitting. If "known 404" has no enumerable definition at the call site, use the safest reversible reading, report it as an assumption.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 2 of 10 within worktree wt-engine. Same-file predecessor: none — first in the stream-engine chain (B2 before C10 before C16). Merges before C10.
