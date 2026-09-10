# Brief C16: graceful model fallback chain (position 9 of 10)

## GOAL
Unknown models 404 on a one-shot switch with no restore messaging. Add the graceful fallback chain with restore messaging, building on B2's passthrough and C10's steering.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: the model region of `worker/src/stream-engine.ts` (plus the minimal `session.ts` model read if the chain needs it — nothing else in `session.ts`) — fallback cycling across models with a restore message when the preferred model returns.
Never: `turns.ts`, `stream-codec.ts`, other `session.ts` regions, the `shaped()` block (B2), the steer queue (C10), the stub-continue branch (A-STUB-TRIM), store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section C item 16: "Model cycling and fallback", Partial — one-shot switch only, no cycling, no restore messaging. Last in the stream-engine chain: B2 then C10 merge first. (Pairs with B1's surfacing: config errors still surface; only unknown-model 404s cycle.)

## ACCEPTANCE
- An unknown-model 404 cycles through the fallback chain instead of failing the turn; when the preferred model recovers, a restore message is emitted.
- Genuine config errors still surface (B1 unregressed); known-404 shaping still applies (B2 unregressed).
- tsc clean in every touched package.
- Before and after probe with pasted output: before shows the one-shot 404 failure; after shows cycling plus the restore message.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: point a turn at an unknown model, show fallback cycling, restore the preferred model, show the restore message; paste the exact commands plus before/after output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Medium. One sitting. If the chain wants a model catalog or health-check framework, shrink to the smallest ordered fallback list with restore messaging and report the cut as a deviation.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 9 of 10 within worktree wt-engine. Same-file predecessor: C10 (position 8) must merge first — stream-engine chain order is B2 before C10 before C16. Merges before A-STUB-TRIM.
