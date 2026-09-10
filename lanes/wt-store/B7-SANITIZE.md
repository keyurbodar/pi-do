# Brief B7-SANITIZE: clamp only non-finite, reject negatives

## GOAL
Fix `numField`/`finiteOr0` so negative usage values are rejected or logged, never silently stored as 0, while non-finite values still clamp.

## ROLE
Implementer. Bounded session. One owner for this worktree; own worktree only.

## SCOPE
Write: `packages/pi-cf/src/store/sql-util.ts` (sanitizer region only, `sql-util.ts:82-85`) and `packages/pi-cf/src/store/entries.ts` (usage coerce regions only, `entries.ts:191-193,222-230`).
Never: the probe/`execPrepared` region (A-EXEC-DEL owns), the MIGRATIONS list, DDL, recovery, engine, `verify-runs.mjs`, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-store`, base `3ef298b`.
Verdicts evidence: section B item 7 ("Sanitizers zero out negatives", `packages/pi-cf/src/store/sql-util.ts:82-85` — "Negative usage becomes zero. Quota caps become untrippable. Under-billing hides. Clamp only non-finite. Reject or log negatives.").

## ORDER
Position 2 of 3 within worktree `wt-store`. Predecessor that must merge first: A-EXEC-DEL (same file `sql-util.ts`; shared hook lines merge in brief order).

## ACCEPTANCE
- Non-finite inputs (NaN, ±Infinity) still clamp to 0.
- A probe with a negative usage value is rejected or logged and never stored as 0 (show the row or log line).
- Quota-cap path can trip on negative/over-limit input instead of seeing a zeroed value.
- `npx tsc --noEmit -p packages/pi-cf` clean.

## VERIFY
`npx tsc --noEmit -p packages/pi-cf`. Own wrangler dev on `:8795` only, `STORE_SQLITE_DIR` set for store-proof; drive a negative-usage probe against the real server and read back the real row (or log). Skill `skills/verification/SKILL.md` rules 1 to 7 apply: real artifact, pasted receipts, named tier.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
