# C4 — Project context files (4/5, wt-context)

## GOAL
Sessions load project context files from the bound session root.

## ROLE
Implementer, bounded to this issue only.

## SCOPE
Write: one new project-context loader file plus its call-in from `packages/pi-cf/src/agent/context.ts`; files load under the session root and feed the existing context sections (no prompt-builder redesign).
Never: engine turn policy, session routes, DDL, verify scripts.
Contract: read the root with `SELECT cwd FROM sessions WHERE sid = ?`. If the `cwd` column is absent, return BLOCKED naming the column; do not invent it, migrate it, or fall back to a fixed workspace root silently.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-context`, base `3ef298b`.
Verdicts: `verdicts.html` section C item 4 (Context files, Missing — "No project file loading. Fixed system prompt"). Depends on the wt-schema `cwd` contract, which this session cannot see.

## ACCEPTANCE
- `tsc` clean in every touched package.
- Context files load from the bound root (seeded project files under the session `cwd` appear in built context; files outside the root do not).
- Missing `cwd` column yields BLOCKED naming `cwd`, with no invented column.

## VERIFY
`tsc` in touched packages plus a per-item probe (seed root files, build context, paste the loaded section; plus the absent-column BLOCKED check if applicable), on your own server only. Skill `skills/verification/SKILL.md` rules 1-7 apply. No formatters, linters, or suites.

## TIMEBOX
Medium. Ship after C11 with receipts.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision. (Standing orders `lanes/STANDING.md` item 10, verbatim intent.)

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups. (Standing orders item 9 shape, per shipped batch.)

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness. Own worktree only; shared hook lines merge in ORDER.

## ORDER
Position 4 of 5 within wt-context. Predecessor: C11 must merge first.
