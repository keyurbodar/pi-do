# Brief B13: fail the turn on chunk persist failure (position 3 of 10)

## GOAL
Chunk persist failure (`worker/src/stream-codec.ts:159-162`) currently becomes a socket frame while the turn stays open and its log silently stops. Fail the turn, or orphan it for the recovery scan — never leave an open turn with a dead log.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: `worker/src/stream-codec.ts` lines 159-162 only — the chunk persist failure path. Either fail the turn with a truthful error or mark the turn orphaned so the recovery scan picks it up.
Never: `turns.ts`, `stream-engine.ts`, `session.ts`, store SQL, recovery scan logic itself, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section B item 13: "Chunk persist failure becomes a socket frame" at `worker/src/stream-codec.ts:159-162` — the turn continues open while its log silently stops. Fix: fail the turn or orphan it for the scan.

## ACCEPTANCE
- A failed chunk persist no longer emits a socket frame on an open turn; the turn either fails with the real persist error or is orphaned for the scan.
- tsc clean in the worker package.
- Before and after probe with pasted output: before shows an open turn plus a socket frame after a forced persist failure; after shows the failed or orphaned turn.
- Sigkill proof green unmodified after this item (per parent lane acceptance).

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: force a chunk persist failure, paste the exact commands plus before/after output, then run the sigkill proof unmodified and paste the green receipt. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Small. One sitting. If neither fail-the-turn nor orphan-for-scan is expressible at this call site without touching the scan, report BLOCKED with the exact missing decision.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 3 of 10 within worktree wt-engine. Same-file predecessor: none — sole toucher of `stream-codec.ts`. Lane-order neighbors: B2 (position 2) merges first; B8 (position 4) merges after.
