# Agent stream

Activates PR10 (WS protocol) / PR08 (fence) — the core proof that the agent
works. A user opens one socket per session, sends prompts, watches model and
tool frames live, and every frame is already persisted.

## Sub-features

- `stream-prompt` sends `prompt` and receives `message_*` plus `tool_*` frames.
- `stream-abort` stops a running turn; the run ends promptly.
- `stream-steer` steers mid-run and the new direction appears in later frames.
- `stream-fence` rejects a stale second socket's write with Fenced/Conflict.

## How to get to it (user POV)

- `WS {BASE}/workspaces/{id}/sessions/{sid}/stream` (ws/wss scheme).
- Client sends `{ "type": "prompt", "text": "..." }`, `{ "type": "abort" }`,
  `{ "type": "steer", "text": "..." }`.
- Server emits `message_start/update/end`, `tool_start/update/end`,
  `agent_start/end`, `entry`.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS and session SID exist; CLI client built (PR17).

- **Prompt.** Send a file-writing prompt. Run
  `cli stream --ws {WS_BASE}/workspaces/{WS}/sessions/{SID}/stream --prompt "write verify-{RUN_ID}/agent.txt containing ok" --frames frames.jsonl`.
  Exit code `0`; `frames.jsonl` contains `agent_start`, at least one
  `tool_start/tool_end` pair, and `agent_end`.
- **Persistence second view.** For every `entry` frame in `frames.jsonl`,
  re-read it. Run
  `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/entries?after=0"`.
  Every streamed entry ID appears in the replay; a frame without a stored
  entry fails the run.
- **Abort.** Start a long turn and abort it. Run the CLI with `--prompt` for a
  long task, then send `--abort` mid-run. The stream ends with a run-end
  marker promptly; tool output stops growing.
- **Fence.** Replay a stale write from a second socket holding an old fence
  token. The server answers Fenced/Conflict and session state is unchanged
  (confirm via entries re-read, not via the socket's word).
- **Proof.** Store `frames.jsonl`, both entry reads, and `transcript.txt` in
  `artifacts/{RUN_ID}/agent-stream/`.

## Gotchas

- Frames are a view; storage is the truth. Always close the loop with entries.
- `tool_update` output is throttled; absence of per-byte frames is normal.
- Never open two prompting sockets on one session except for the fence test.
