# Brief C9: composable prompt seam (position 7 of 10)

## GOAL
Build the composable prompt seam in new `packages/pi-cf/src/agent/prompt.ts`: sections plus snippets replacing the one constant passed verbatim. Exactly one registration line in `session.ts`.

## ROLE
Implementer, bounded to this single issue. Own worktree only.

## SCOPE
Write: new file `packages/pi-cf/src/agent/prompt.ts` (sections plus snippets, smallest shape that composes), plus one registration line in `packages/pi-cf/src/agent/session.ts`.
Never: `turns.ts`, `stream-engine.ts`, `stream-codec.ts`, any other `session.ts` region, store SQL, recovery scan, compaction, verify scripts, session routes.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-engine`, base `3ef298b`.
Verdicts evidence `verdicts.html` section C item 9: "Prompt builder", Missing — one constant passed verbatim, no sections, no snippets. Last in the `session.ts` chain (B8, C22, C20 merge first) so the single registration line lands on stable code.

## ACCEPTANCE
- `prompt.ts` composes a prompt from sections plus snippets; the turn path uses the composed prompt instead of the verbatim constant.
- `session.ts` diff is exactly one registration line.
- tsc clean in `packages/pi-cf`.
- Before and after probe with pasted output: before shows the verbatim constant reaching the turn; after shows sections plus snippets composed and delivered.

## VERIFY
Per-item probe on your own server only, per `skills/verification/SKILL.md` rules 1 to 7: register two sections plus one snippet, show the composed prompt on a turn, paste the exact commands plus output. Fast tier 20/20 on your own server. No suites, no linters, no formatters.

## TIMEBOX
Medium. One sitting. If composition wants a framework, shrink to the smallest section/snippet join that works and report the cut as a deviation.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 applies in full: do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
Standing orders item 9 shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.

## ORDER
Position 7 of 10 within worktree wt-engine. Same-file predecessor: C20 (position 6) must merge first — `session.ts` chain order is B8 before C22 before C20 before C9. The new `prompt.ts` file has no predecessor.
