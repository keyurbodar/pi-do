# Standing orders for every lane

Read `skills/verification/SKILL.md` first. It outranks this file on proof.

1. Follow YAGNI principles, and prefer one-liner solutions.
2. Verification is mandatory per the skill above. No receipt, no done.
3. Own worktree only. Never touch siblings' files. Shared hook lines merge in the order the brief states.
4. Smallest diff that solves the item. Delete over abstract. No new dependencies.
5. One-liner over helper. Helper over module. Module over framework.
6. Comments explain only the non-obvious why. No phase narration. No capability advertising.
7. tsc clean in every touched package before any proof run.
8. Throwaway scripts die before the report. Scratch servers stop. Ports freed.
9. Report shape: PASS | ISSUES | BLOCKED, then files changed, verification commands plus output, deviations, follow-ups.
10. Do not call task. Do not start subagents. Do not merge. Do not ask the user anything. Ambiguity resolves to the safest reversible reading, reported as an assumption, or BLOCKED with the exact missing decision.
