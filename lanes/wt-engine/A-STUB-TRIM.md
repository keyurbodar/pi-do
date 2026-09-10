# Brief A-STUB-TRIM: census the stub-continue branch (position 10 of 10)

## GOAL
Decide by census whether the stub-continue branch (`worker/src/stream-engine.ts:312-375`) stays or goes: if no stub turn needs prefix resume, delete the branch. The `recovery.ts` builder stays either way.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: `worker/src/stream-engine.ts` lines 312-375 only — delete if and only if the census shows no stub turn needs prefix resume; otherwise keep and report the census rows that force the keep.
Never: `turns.ts`, `stream-codec.ts`, `session.ts`, the `shaped()` block (B2), steer/fallback regions (C10, C16), `recovery.ts` (builder stays), store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section A: "ResumeTool stub-continue branch", ~90 lines, TRIM — keep the builder; the stub-continue branch can go once keyed paths cover resume. Last in the lane; runs after the full stream-engine chain (B2, C10, C16) so the census observes final behavior.

## ACCEPTANCE
- Census output pasted: stub-turn prefix-resume demand present (keep, with rows cited) or absent (delete lines 312-375).
- If deleted: `recovery.ts` builder intact and still referenced; nothing else in `stream-engine.ts` changed.
- tsc clean in the worker package.
- Before and after probe with pasted output, plus the deletion proof: tier green after the cut with the exact non-move list (verification skill rule 6).
- Sigkill proof green unmodified after this item (per parent lane acceptance).

## VERIFY
Census plus probes on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: paste the census command plus output, the before/after probe output, and the unmodified sigkill green receipt. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Small. One sitting. If the census is inconclusive, the safest reversible reading is keep-the-branch; report the inconclusive rows as the assumption.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 10 of 10 within worktree wt-engine. Same-file predecessor: C16 (position 9) must merge first — shares `stream-engine.ts` with the B2/C10/C16 chain but touches the disjoint 312-375 branch region, so it lands last. Lane-order neighbor: C16. No successor.
