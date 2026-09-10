# Lane wt-recovery: resume math without guessing

## GOAL
Resume redrives from recorded cursor pins only. Delete the count-guessing fallback.

## ROLE
Implementer. Bounded session. One owner for this worktree.

## SCOPE
Write: `packages/pi-cf/src/store/recovery.ts` (`lastCommittedSeq` plus count fallback, roughly lines 199-231).
Never: engine, codec, chunks, runs, verify scripts.

## CONTEXT
Repo `/Users/keyur/Documents/pi-do`, worktree `.worktrees/wt-recovery`, base `3ef298b`. Evidence in `verdicts.html` sections A and B item 4.
The pre-migration NULL-cursor fallback assumes first-K-entries map to seqs 0 to K-1. Its own comment admits the single-writer assumption. Any steer or compact gap resumes from the wrong suffix, duplicating or skipping deltas. Gate resume on cursor presence. Refuse or snapshot-rebuild legacy stores instead of guessing.

## ACCEPTANCE
- tsc clean in `packages/pi-cf` and `worker`.
- No COUNT-based seq inference remains.
- A legacy NULL-cursor store resolves to refuse or rebuild, never to a guessed suffix.
- `verify/sigkill-e2e.sh` passes unmodified on your own server.

## VERIFY
`npx tsc --noEmit -p packages/pi-cf`, then worker. Sigkill script owns its server on `:8793`; read its header first. Skill `skills/verification/SKILL.md` rules 1 to 7 apply.

## TIMEBOX
One sitting. Return partial with receipts rather than broadening scope.

## FORBIDDEN
Standing orders `lanes/STANDING.md` item 10 apply in full.

## REPORT
Standing orders item 9 shape.

## STANDING
`lanes/STANDING.md` plus `skills/verification/SKILL.md`. YAGNI and one-liners outrank cleverness.
