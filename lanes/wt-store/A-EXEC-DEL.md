# Brief A-EXEC-DEL: delete execPrepared, inline exec

## GOAL
Delete the dead prepared-statement wrapper in `sql-util.ts` and inline plain exec at every call site, so no call pays a probe lookup that always misses.

## ROLE
Implementer. Bounded session. One owner for this worktree; own worktree only.

## SCOPE
Write: `packages/pi-cf/src/store/sql-util.ts` (probe plus WeakMap region only, `sql-util.ts:11-57`; inline plain exec at each former `execPrepared` call site). Delete the wrapper export and its probe cache.
Never: the MIGRATIONS list, DDL, recovery, engine, `numField`/`finiteOr0` sanitizer regions (`sql-util.ts:82-85`), `entries.ts`, `verify-runs.mjs`, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-store`, base `3ef298b`.
Verdicts evidence: section A row "execPrepared probe plus fallback" (~47 lines, DELETE — "Probe always misses on current runtimes. Every call pays a lookup then plain exec. Inline exec. Resurrect only with a benchmark.") plus section B item 3 ("Probe caches null forever, silent downgrade", `packages/pi-cf/src/store/sql-util.ts:24-56` — "One transient prepare failure pins a query to slow exec invisibly. Goes away with the section A delete.").

## ORDER
Position 1 of 3 within worktree `wt-store`. Predecessor that must merge first: none. B7-SANITIZE touches the same file and merges after this brief.

## ACCEPTANCE
- Zero references to `execPrepared` outside history (grep the worktree).
- Every former call site runs plain exec directly; no probe, no WeakMap, no fallback branch.
- `npx tsc --noEmit -p packages/pi-cf` clean.
- Fast tier 20/20 green on your own server (`:8795`, scratch persist, `STORE_SQLITE_DIR` set) after the cut.

## VERIFY
`npx tsc --noEmit -p packages/pi-cf`. Own wrangler dev on `:8795` only, `STORE_SQLITE_DIR` set for store-proof. Skill `skills/verification/SKILL.md` rules 1 to 7 apply: real server, pasted receipts, named tier, deletions get proof (tier green after the cut plus exact non-move list), no self-verification.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
