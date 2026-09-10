# C14 — Branch-scoped reads (5/5, wt-context)

## GOAL
Context reads walk the session lineage chain instead of one linear chain.

## ROLE
Implementer, bounded to this issue only.

## SCOPE
Write: new branch-read code in `packages/pi-cf/src/agent/context.ts` only — walk the lineage chain and scope reads to the branch (keep the existing projection, grouping, and trim semantics).
Never: fork routes, checkpoints/rewind, engine turn policy, session routes, DDL, verify scripts.
Contract: read lineage with `SELECT parentSessionId FROM sessions WHERE sid = ?`. If the `parentSessionId` column is absent, return BLOCKED naming the column; do not invent it or infer lineage from entries.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-context`, base `3ef298b`.
Verdicts: `verdicts.html` section C item 14 (Branch-scoped reads, Missing — "Linear reads only. No branch walk"). Depends on the wt-schema lineage contract, which this session cannot see.

## ACCEPTANCE
- `tsc` clean in every touched package.
- Branch reads walk lineage (a branched session's context includes its ancestors' entries in chain order and excludes sibling-branch entries).
- Missing `parentSessionId` column yields BLOCKED naming `parentSessionId`, with no invented column.

## VERIFY
`tsc` in touched packages plus a per-item probe (seed parent/child/sibling sessions, build branch context, paste the included/excluded cursors; plus the absent-column BLOCKED check if applicable), on your own server only. Skill `skills/verification/SKILL.md` rules 1-7 apply. No formatters, linters, or suites.

## TIMEBOX
Medium. Ship last with receipts.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision. (Standing orders `lanes/STANDING.md` item 10, verbatim intent.)

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups. (Standing orders item 9 shape, per shipped batch.)

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness. Own worktree only; shared hook lines merge in ORDER.

## ORDER
Position 5 of 5 within wt-context. Predecessor: C4 must merge first.
