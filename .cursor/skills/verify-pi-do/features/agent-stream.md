# Agent stream

Activates PR10 (WS protocol) / PR08 (fence), extended by PR11 (per-session
queue: concurrent prompts serialize, no busy reject). A user opens one
socket per session, sends prompts, watches entry frames live, and every
frame is already persisted.

## Sub-features

- `stream-prompt` sends `prompt` and receives `{entry}` frames plus a terminal `{done}`.
- `stream-abort` stops a running turn; the run is marked `interrupted` and the socket sends `{aborted}`.
- `stream-steer` appends a `steer` entry mid-turn; it is persisted only, the running turn keeps its original direction.
- `stream-fence` rejects a stale second socket with Fenced/Conflict and closes the socket; entries are unchanged.
- `stream-serialize` runs two prompts back to back on one session; the second completes after the first with no error frame.

## How to get to it (user POV)

- `WS {BASE}/workspaces/{id}/sessions/{sid}/stream` (ws/wss scheme).
- Client sends `{prompt, fence, expected}`, `{abort: true}`, or `{steer: true, text}`.
- Server emits `{entry: {cursor, type, body}}` where type is one of `prompt`,
  `toolCall`, `toolResult`, `result`, `steer`, `interrupted`, `error`,
  plus `{done, fence, revision, result}`, `{aborted, runId}`, `{error, hint}`,
  and `{ping}` heartbeats.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS and session SID exist; CLI client built (PR17, landed).

- **Prompt.** Send a file-writing prompt. Run
  `cli stream --ws {WS_BASE}/workspaces/{WS}/sessions/{SID}/stream --prompt "write verify-{RUN_ID}/agent.txt containing ok" --frames frames.jsonl`.
  Exit code `0`; `frames.jsonl` holds `{entry}` frames ending in `{done:true}`,
  never `agent_start`/`tool_start` vocabulary.
- **Persistence second view.** For every `entry` frame in `frames.jsonl`,
  re-read it. Run
  `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/entries?after=0"`.
  Every streamed entry ID appears in the replay; a frame without a stored
  entry fails the run.
- **Abort.** Start a long turn and abort it. Run the CLI with `--prompt` for a
  long task, then send `--abort` mid-run. The stream sends `{aborted}` with
  the run id, the run's entry reads back `interrupted`, and a prompt sent
  after the abort still executes.
- **Steer.** Send `{steer: true, text}` mid-turn. The `steer` entry appears in
  the replay but the turn result is unchanged; steering redirects nothing.
- **Serialize.** Send two prompts back to back on one session. Both complete
  in arrival order with gapless cursors and no error frame.
- **Fence.** Connect a second socket holding a stale fence token. The server
  answers Fenced/Conflict, closes with 4403/4409, and session state is
  unchanged (confirm via entries re-read, not via the socket's word).
- **Proof.** Store `frames.jsonl`, both entry reads, and `transcript.txt` in
  `artifacts/{RUN_ID}/agent-stream/`.

## Gotchas

- Frames are a view; storage is the truth. Always close the loop with entries.
- `tool_update` output is throttled; absence of per-byte frames is normal.
- Never open two prompting sockets on one session except for the fence test.
- Concurrent prompts queue; a second prompt is never rejected, it waits.
