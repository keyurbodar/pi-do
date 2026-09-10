# Lane wt-store: store hygiene

## GOAL
Delete the dead prepared-statement wrapper, fix silent zeroing of usage values, and prove the entries logic against real SQLite.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: `packages/pi-cf/src/store/sql-util.ts` (probe plus sanitizer regions only, never the MIGRATIONS list), `packages/pi-cf/src/store/entries.ts` (usage coerce regions only), `packages/pi-cf/verify-runs.mjs`.
Never: MIGRATIONS, DDL, recovery, engine, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-store`, base `3ef298b`. Evidence in `verdicts.html` sections A and B items 3, 7, 12.
1. A-EXEC-DEL plus B3. `execPrepared` probe plus WeakMap (`sql-util.ts:11-57`) always misses on current runtimes, so every call pays a lookup then plain exec. Inline plain exec at every call site and delete the wrapper.
2. B7. `numField`/`finiteOr0` (`sql-util.ts:82-85`, `entries.ts:191-193,222-230`) coerce negatives and NaN to 0, which makes quota caps untrippable. Clamp only non-finite. Reject or log negatives.
3. B12. `verify-runs.mjs:25-114` answers by query prefix. Drive it against real SQLite or assert exact query texts.

## ACCEPTANCE
- tsc clean in `packages/pi-cf`.
- Zero references to `execPrepared` outside history.
- A probe shows a negative usage value rejected or logged, never stored as 0.
- verify-runs exercises the real backend or exact queries.
- Fast tier 20/20 on your own server (`:8795`, scratch persist, `STORE_SQLITE_DIR` set).

## VERIFY
`npx tsc --noEmit -p packages/pi-cf`. Own wrangler dev on `:8795` only. `STORE_SQLITE_DIR` set for store-proof. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
