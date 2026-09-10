# Lane wt-tools: plan mode, projectors, live state

## GOAL
A read-only plan mode, a registry for custom entry projectors, and a watchable session snapshot bus.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: `cli` plan flag, run-path read-only guard, new projector registry module plus `ENTRY_PROJECTION` hookup, new snapshot bus module plus endpoint, `packages/pi-cf/src/agent/session.ts` hook lines only (one registration line per feature, merged after wt-engine).
Never: engine turn policy, store SQL internals, recovery scan, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-tools`, base `3ef298b`. Evidence in `verdicts.html` section C items 21, 15, 18.
C21 is a pure read-only flag with no approval gate. Approvals are out of scope by root decision. C15 turns the fixed 6-key `ENTRY_PROJECTION` (`sql-util.ts:211-218`) into a registry so unknown types stop landing in skipped. C18 adds the run start and end bus plus a watchable snapshot endpoint next to the point-read meta. Hooks into `session.ts` stay one line each and merge after wt-engine.

## ACCEPTANCE
- tsc clean in every touched package.
- Plan mode blocks a write with pasted output.
- A registered projector projects with pasted output. Unregistered types keep old behavior.
- A watcher observes run start, snapshot, and run end with pasted frames.
- Fast tier 20/20 on your own server.

## VERIFY
tsc plus per-item probes. Own server only. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
One sitting per item. Return partial with receipts rather than broadening scope.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
