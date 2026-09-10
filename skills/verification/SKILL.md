---
name: verification
description: "Mandatory proof discipline for every pi-do lane. Green means executed commands with pasted receipts, never claims. Self-evolving: append a lesson whenever a proof lies or a new failure mode appears."
---

# Verification

Every change ends in executed proof. A claim without a receipt is not done.

## Rules

1. Prove against the real artifact. Boot a real server, run the real script, read the real rows. Typecheck alone is never proof.
2. Paste receipts. Every report carries the exact commands plus their output. `tsc` exit codes, PASS lines, wall times, row counts.
3. Name the tier. Fast tier 20/20, keyed tier with BLOCKED called out, kill proof, or soak. Say which one and why it covers the change.
4. BLOCKED is not PASS. A proof that never touched inference exits nonzero-distinct and says BLOCKED. A suite with a required proof BLOCKED is red.
5. Flakes get proven, not rerun. A red that passes on retry needs the root cause named with evidence, or it stays red.
6. Deletions get proof too. Show the tier green after the cut plus the exact non-move list.
7. No self-verification. Your report is evidence. The root reruns and decides.

## Maintain

This skill evolves. When a proof lies, a new failure mode appears, or a receipt format changes, append one numbered rule above before you act. One line each. Never restate an existing rule.
