# Chat thread

Activates with the web frontend (`frontend/web`, live on the shared dev
server). A user opens the app in a browser, types a prompt, watches their
message appear as a bubble, and the assistant's answer streams in below it
until the turn settles.

## Sub-features

- `web-thread-open` loads the app and bootstraps a fresh session; the empty thread shows the ready status line.
- `web-thread-send` puts the prompt in the thread as a right-aligned user bubble the moment it is sent (optimistic pending row).
- `web-thread-stream` renders the assistant turn live: working timer, streamed text, thinking and tool chips when the model emits them.
- `web-thread-settle` ends the turn: the working row is replaced by the settled fold row, and every streamed part re-reads from the entries API.
- `web-thread-error` shows a `role="alert"` error block instead of a thread when the backend is unreachable or unkeyed.

## How to get to it (user POV)

- Open `http://localhost:3000` in a browser.
- On load the app calls `GET {WORKER}/models` (keyed-provider check), then
  `POST {WORKER}/workspaces`, `POST .../sessions`, `claim`, and `model` —
  a fresh session every page load, no stored history.
- Ready state: `.thread` shows the status line "New session ready — send a
  prompt to start." and the composer sits in the `.composer` footer.
- Failure states render inside `.thread` with `role="alert"`: the unkeyed
  message ("No model provider key is set on the backend…") or the bootstrap
  error text.

## Driving it in the browser

Preconditions:

- The shared dev server answers at `http://localhost:3000` (never start your
  own instance on 3000 — see SKILL.md "Web surface").
- `helpers/doctor.sh` exits `0` at the Worker BASE (default
  `http://127.0.0.1:8787`).
- At least one keyed provider: `GET {BASE}/models` returns a non-empty
  `keyed` list.
- `sh helpers/web-check.sh` passes (exit `0`) before the first drive step.
- Browser automation with console capture attached before navigation.

- **Open.** Navigate to `http://localhost:3000`. Wait for the status line
  "New session ready — send a prompt to start." inside `.thread`. Zero
  console errors; store `01-open.png` and the console record.
- **Correlate.** From the captured network log, read the `POST /workspaces`
  and `POST .../sessions` response bodies for `workspaceId`/`sessionId` —
  the web run's WS/SID for second-view proofs. Record them in the
  transcript.
- **Send.** Type `write verify-{RUN_ID}/web.txt containing ok` into
  `[role="textbox"][aria-label="Ask AI Agent"]` and press Enter (or click
  `[aria-label="Send"]`). The user bubble
  (`[data-slot="message"][data-role="user"]`) appears immediately; store
  `02-sent.png`.
- **Stream.** While the turn runs, `.thread` shows the working row ("Working
  for Ns") and assistant content streams under it
  (`[data-slot="message"][data-role="assistant"]`). Store `03-streaming.png`
  mid-stream — proof of streaming, not just the end state.
- **Settle.** The working row is replaced by the fold row (button,
  `aria-label="Toggle turn details"`, label "Worked for Ns"); the terminal
  text stays visible. Store `04-settled.png`.
- **Second view.** Re-read the persisted entries:
  `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/entries?after=0"`. Every
  part shown in the browser has a stored entry; a streamed part without a
  stored entry fails the run.
- **Proof.** Store screenshots, the console record, the transcript with the
  network log, and the entries re-read in
  `artifacts/{RUN_ID}/web-thread/`.

## Gotchas

- The Worker must be up on 8787 (or `PUBLIC_WORKER_URL`): the app bootstraps
  against it on load; with the Worker down the page renders the bootstrap
  error block, not a thread.
- Unkeyed backend: `GET /models` returns an empty `keyed` list and the page
  shows the "No model provider key is set…" alert instead of a thread. Set
  the provider key as a Worker secret, redeploy, reload.
- Fresh session per load: there is no history to resume, and a reload
  orphans the previous session. Capture WS/SID from the network log of the
  same load you drive.
- A turn that ran keyless renders a "Provider key required" error card with
  Retry instead of agent content — that is the designed mask, not a stream
  bug.
- The thread auto-scrolls only while pinned; a scrolled-up view stops
  following. Scroll to bottom (or use the jump pill) before asserting on the
  latest row.
