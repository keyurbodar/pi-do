# Brief B12-VERIFY-RUNS: prove entries logic against real SQLite

## GOAL
Make `verify-runs.mjs` prove the entries logic against real SQLite (or exact query texts) instead of answering by query prefix.

## ROLE
Implementer. Bounded session. One owner for this worktree; own worktree only.

## SCOPE
Write: `packages/pi-cf/verify-runs.mjs` only (fake-backend region, `verify-runs.mjs:25-114`).
Never: `sql-util.ts`, `entries.ts`, MIGRATIONS, DDL, recovery, engine, other verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-store`, base `3ef298b`.
Verdicts evidence: section B item 12 ("Fake backend proves entries logic", `packages/pi-cf/verify-runs.mjs:25-114` — "Prefix-matching fake answers queries real SQLite never exhibits. Drive against real SQLite or assert exact query texts.").

## ORDER
Position 3 of 3 within worktree `wt-store`. Predecessor that must merge first: none (independent file; merges in any order).

## ACCEPTANCE
- verify-runs exercises the real backend (real SQLite rows read back) or asserts exact query texts — no prefix-matching fake answers.
- A run against real SQLite shows the entries path landing real rows (paste row counts or rows).
- `npx tsc --noEmit -p packages/pi-cf` clean (if the script is typechecked; otherwise state it is out of the tsconfig and why).
- Fast tier 20/20 on your own server (`:8795`, scratch persist, `STORE_SQLITE_DIR` set).

## VERIFY
`npx tsc --noEmit -p packages/pi-cf`. Own wrangler dev on `:8795` only, `STORE_SQLITE_DIR` set for store-proof; run the real `verify-runs.mjs` against real SQLite. Skill `skills/verification/SKILL.md` rules 1 to 7 apply: real artifact, pasted receipts, named tier.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
