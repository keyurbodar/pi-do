# Lane wt-engine: turn control without silent failures

## GOAL
Errors that mislead become errors that tell the truth, zero budgets mean zero, and the turn loop gains retry, steering, fallback, and prompt seams.

## ROLE
Owner. Coupled multi-step session, sequential inside. One owner for this worktree.

## SCOPE
Write: `worker/src/routes/turns.ts`, `worker/src/stream-engine.ts`, `worker/src/stream-codec.ts`, `packages/pi-cf/src/agent/session.ts` (budgets, thinking, model, prompt-hook regions), new file `packages/pi-cf/src/agent/prompt.ts`.
Never: store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`. Evidence in `verdicts.html` sections A and B items 1, 2, 6, 8, 13 plus C items 9, 10, 16, 20, 22. Order inside the lane:
1. B1. `turns.ts:66-74` swallows runtime build failure into `{}`. Remove the try/catch. Let it surface.
2. B2. `shaped()` (`stream-engine.ts:251-255`) truncates at 300 chars and invents model errors. Pass through message plus cause. Shape known 404s only.
3. B13. Chunk persist failure (`stream-codec.ts:159-162`) becomes a socket frame while the turn stays open. Fail the turn or orphan it for the scan.
4. B8. `session.ts:331-339` turns explicit `maxTurns: 0` into 25. Honor explicit zero. Default only the undefined.
5. C22. Budgets are plumbed. Add the harness retry policy, stream options, and the parallel versus sequential knob.
6. C20. The turn path uses requested thinking (`session.ts:216`), not the derived value. Use the derived one.
7. C9. Build the composable prompt seam in new `prompt.ts`. One registration line in `session.ts`.
8. C10. Single mid-turn steer exists. Add follow-up queues and split-abort reconciliation.
9. C16. Unknown models 404. Add the graceful fallback chain with restore messaging.
10. A-STUB-TRIM. Delete or keep the stub-continue branch (`recovery.ts` builder stays, engine branch `stream-engine.ts:312-375`). Decide by census: if no stub turn needs prefix resume, delete.

## ACCEPTANCE
- tsc clean in both packages.
- Each of the ten items shows a before and after probe with pasted output.
- Fast tier 20/20 on your own server. Sigkill green unmodified after items 3 and 10.

## VERIFY
Per-item probes plus the tiers. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
Large lane. Ship items 1 to 4 first with receipts, then continue in order.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape, per shipped batch.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
