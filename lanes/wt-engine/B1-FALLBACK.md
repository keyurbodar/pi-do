# Brief B1: remove the turns.ts fallback swallow (position 1 of 10)

## GOAL
`worker/src/routes/turns.ts:66-74` swallows a runtime build failure into `{}`. Remove the try/catch so the failure surfaces instead of degrading into a fabricated empty object.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: `worker/src/routes/turns.ts` lines 66-74 only — delete the try/catch that degrades thinking validation to `{}`.
Never: `stream-engine.ts`, `stream-codec.ts`, `session.ts`, store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section B item 1: "Silent model fallback swallows resolve failure" at `worker/src/routes/turns.ts:66-74` — thinking validation degrades to an empty object, error text is fabricated, the real config error is lost. Fix: remove try/catch, let the build failure surface.

## ACCEPTANCE
- The try/catch at `turns.ts:66-74` is gone; a runtime build failure propagates to the caller with its real message.
- tsc clean in the worker package.
- Before and after probe with pasted output: before shows `{}` plus fabricated error text on a forced build failure; after shows the real error surfacing.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: force the build failure, paste the exact command plus before/after output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Small. One sitting. If the removal cascades beyond the 66-74 block, stop and report BLOCKED with the exact decision needed.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 1 of 10 within worktree wt-engine. Same-file predecessor: none — first and only toucher of `turns.ts`, and first in lane order. Merges first.
