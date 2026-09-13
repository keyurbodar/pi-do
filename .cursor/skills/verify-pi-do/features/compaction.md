# Compaction

Activates the Compaction feature (PR48a-c + PR50). When a session's live
entries approach the model's context window (last provider-reported usage is
the exact anchor; chars/4 estimates only the tail), the session is marked and
the alarm archives the old prefix to paginated cold storage, appends one
`compaction` summary entry, and re-roots the entry chain so resume reads
summary + live tail. Keyless sessions use a deterministic summary; keyed
sessions use an LLM summary (pi's structured format, iteratively merged with
the previous summary). A turn that overflows the window gets one emergency
compaction and a single retry.

## Sub-features

- `auto-mark` crossing the window reserve marks the session without compacting mid-turn.
- `manual-compact` the compact route runs the same code path explicitly and reports `summarySource`.
- `archive-re-read` archived pages re-read equal the compacted prefix; tail cursors stay byte-stable.
- `model-summary` with a key, the persisted summary is LLM-generated (`summarySource: "model"`); keyless is deterministic.
- `overflow-recovery` an overflow-failed turn recovers via one forced compaction + retry.

## How to get to it (user POV)

- `POST {BASE}/workspaces/{id}/sessions/{sid}/compact` (manual compact).
- `GET {BASE}/workspaces/{id}/sessions/{sid}/archive?page=N` (archive pages).
- `GET {BASE}/workspaces/{id}/sessions/{sid}/meta` — `compaction.pending`, `archivePages`, `archiveTotal`.
- Auto: seed turns past the window reserve and wait for the alarm; no user action.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS and a session SID exist; keyless is fine (deterministic
  summary; keyed summary needs OPENCODE_API_KEY per the keyed BLOCKED
  convention — see verify/keyed-spark-summary.sh).

- **Auto mark + archive.** Seed ~6 stub turns (`cli run --ws --sid --prompt ...`),
  poll `meta` until `compaction.pending` is true, then past the alarm cadence
  re-read `meta` (`archiveTotal` grows) and `entries` — the chain now reads
  summary + tail. Proven end to end by `verify/compaction-proof.sh`.
- **Manual compact.** `curl -s -X POST "{BASE}/workspaces/{WS}/sessions/{SID}/compact"`
  — HTTP 200 with `summarySource` (`"deterministic"` keyless, `"model"` keyed).
- **Archive re-read.** `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/archive?page=1"`
  returns `{entries, page, pages, total}`; page entries match the compacted prefix.
- **Model summary.** With the funded key (source `worker/.dev.vars`), run
  `sh verify/keyed-spark-summary.sh` — asserts `summarySource: "model"` and a
  pi-structured summary body; keyless runs must report BLOCKED, never fake PASS.
- **Overflow recovery.** `sh verify/overflow-recovery.sh` — one forced
  compaction + single retry on an overflow failure (keyed convention).

## Gotchas

- Compaction never runs mid-turn; a busy session waits for the alarm. A
  pending mark with unchanged `archiveTotal` is "waiting", not "stuck" —
  check again after the alarm cadence.
- Keyless reserve (16384) exceeds the stub window (1000), so keyless sessions
  mark constantly; the keep-tail + turn-start gates decide actual cutting.
  Extra marks are expected, not a bug.
- The manual compact route on a session with nothing to archive reports
  `compacted: false` — that is success, not failure.
- Summary quality checks need a key; keyless summaries are the deterministic
  one-sentence-per-turn synthesizer by design. `summarySource` has three
  values: `"deterministic"` (keyless), `"model"` (keyed), `"degraded"`
  (keyed call threw or returned empty — fell back, never fails compaction).
