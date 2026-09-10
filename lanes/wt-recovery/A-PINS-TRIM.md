# Brief A-PINS-TRIM: delete count fallback, gate on cursor presence

## GOAL
Resume redrives from recorded cursor pins only. Delete the count-guessing fallback in `lastCommittedSeq` so a legacy NULL-cursor store refuses or snapshot-rebuilds instead of resuming from a guessed suffix.

## ROLE
Implementer. Bounded session. One owner for this worktree. No subagents, no merge, no user questions.

## SCOPE
Write: `packages/pi-cf/src/store/recovery.ts` (`lastCommittedSeq` plus count fallback, roughly lines 199-231). Remove all COUNT-based seq inference; gate resume on cursor presence (refuse or snapshot-rebuild path for NULL cursors).
Never: engine, codec, chunks, runs, verify scripts. No new dependencies, no refactors beyond the fallback deletion.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-recovery`, base `3ef298b`. Evidence in `verdicts.html` sections A and B item 4.
The pre-migration NULL-cursor fallback assumes first-K-entries map to seqs 0 to K-1. Its own comment admits the single-writer assumption. Any steer or compact gap resumes from the wrong suffix, duplicating or skipping deltas.

## ACCEPTANCE
- tsc clean in `packages/pi-cf` and `worker`.
- No COUNT-based seq inference remains in `recovery.ts`.
- A legacy NULL-cursor store resolves to refuse or rebuild, never to a guessed suffix.
- `verify/sigkill-e2e.sh` passes unmodified on your own server.

## VERIFY
`npx tsc --noEmit -p packages/pi-cf`, then worker. Sigkill script owns its server on `:8793`; read its header first. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## ORDER
1 of 1 within `wt-recovery`. Predecessor: none.

## FORBIDDEN
Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.

## REPORT
PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
