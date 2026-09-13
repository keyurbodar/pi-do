# Chat thread

Activates with the web frontend (`frontend/web`, live on the shared dev
server). A user opens the app in a browser, types a prompt, watches their
message appear as a right-aligned bubble, and the assistant's answer streams
in below it — markdown-rendered, with the active roster bot's avatar, a
shimmer activity row while the tail streams, and a jump pill when scrolled
up — until the turn settles. Streaming runs against the real Worker
(default `http://127.0.0.1:8787`), not a mock.

## Sub-features

- `web-thread-open` loads the app and bootstraps a fresh session; the empty thread shows the ready status line.
- `web-thread-send` puts the prompt in the thread as a right-aligned user bubble (`thread-item-{id}`) the moment it is sent (optimistic pending row).
- `web-thread-stream` renders the assistant turn live over the Worker WS: working timer, streamed text with a blinking cursor on the live tail, thinking and tool chips when the model emits them, and the `activity-row` (avatar + "Receiving context…" shimmer) while the last turn streams on an open connection.
- `web-thread-settle` ends the turn: the working row is replaced by the settled fold row, the activity row disappears, and every streamed part re-reads from the entries API.
- `web-thread-markdown` renders bubble text as markdown (GFM tables/lists, `remark-breaks` line breaks, code blocks, links opening in a new tab).
- `web-thread-avatar` shows the active roster bot's avatar (BotAvatar, presence-aware) to the left of every assistant bubble once a bot is selected in the roster.
- `web-thread-scroll` pins the viewport to the bottom while content lands; scrolling up reveals the `scroll-to-bottom` pill, which jumps back and re-pins.
- `web-thread-retry` renders a "Turn failed." row with a `retry-{runId}` button on errored turns; clicking it re-queues the same prompt.
- `web-thread-error` shows a `role="alert"` error block instead of a thread when the backend is unreachable or unkeyed.

## How to get to it (user POV)

- Open `http://localhost:3000` in a browser.
- On load the app calls `GET {WORKER}/models` (keyed-provider check), then
  `POST {WORKER}/workspaces`, `POST .../sessions`, `claim`, and `model` —
  a fresh session every page load, no stored history.
- Ready state: `.thread` shows the status line "New session ready — send a
  prompt to start." and the composer sits in the `.composer` footer.
- Every rendered message — user, assistant, and approval cards — is
  `[data-testid="thread-item-{id}"]`; user bubbles right-align, assistant
  bubbles sit left with the avatar slot when a roster bot is selected.
- Failure states render inside `.thread` with `role="alert"`: the unkeyed
  message ("No model provider key is set on the backend…") or the bootstrap
  error text.

## Driving it in the browser

Preconditions:

- The shared dev server answers at `http://localhost:3000` (never start your
  own instance on 3000 — see SKILL.md "Web surface").
- `helpers/doctor.sh` exits `0` at the Worker BASE (default
  `http://127.0.0.1:8787`) — the thread streams from this real Worker.
- At least one keyed provider: `GET {BASE}/models` returns a non-empty
  `keyed` list.
- `sh helpers/web-check.sh` passes (exit `0`) before the first drive step.
- Browser automation with console capture attached before navigation; the
  console record is mandatory evidence for every pass.

- **Open.** Navigate to `http://localhost:3000`. Wait for the status line
  "New session ready — send a prompt to start." inside `.thread`. Zero
  console errors; store `01-open.png` and the console record.
- **Correlate.** From the captured network log, read the `POST /workspaces`
  and `POST .../sessions` response bodies for `workspaceId`/`sessionId` —
  the web run's WS/SID for second-view proofs. Record them in the
  transcript.
- **Select a bot.** Click `roster-row-chief` in the sidebar (see
  [web-roster](./web-roster.md)) so assistant bubbles carry the Chief
  avatar. Skip for bare bubbles.
- **Send.** Type `write verify-{RUN_ID}/web.txt containing ok` into
  `[data-testid="composer-input"]` and press Enter (or click
  `[data-testid="composer-send"]`). The user bubble
  (`[data-testid^="thread-item-"]`, right-aligned) appears immediately as
  the optimistic pending row; store `02-sent.png`.
- **Stream.** While the turn runs, `.thread` shows the working row ("Working
  for Ns") and assistant content streams under it
  (`[data-testid^="thread-item-"]` with the avatar slot when a bot is
  selected). With the connection open and the last turn streaming,
  `[data-testid="activity-row"]` (aria-live "polite", avatar + "Receiving
  context…" shimmer) sits under the tail. Store `03-streaming.png`
  mid-stream — proof of streaming, not just the end state; the activity row
  is gone once settled, so capture it now.
- **Markdown.** Send a prompt that returns markdown (e.g. `reply with a
  bold word, an inline code span, and a two-item numbered list`). The
  settled assistant bubble renders `<strong>`, `<code>` (inline code
  styling), and an `<ol>` — raw `**`/backtick characters must not be
  visible. Store `04-markdown.png`.
- **Settle.** The working row is replaced by the fold row (button,
  `aria-label="Toggle turn details"`, label "Worked for Ns"); the terminal
  text stays visible and `activity-row` is removed. Store `05-settled.png`.
- **Scroll pill.** With enough content to overflow, scroll the thread up.
  `[data-testid="scroll-to-bottom"]` appears; clicking it scrolls back down
  and the pill disappears, and new streamed content pulls the viewport
  again. Store `06-scrolled.png` and `07-jumped.png`.
- **Second view.** Re-read the persisted entries:
  `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/entries?after=0"`. Every
  part shown in the browser has a stored entry; a streamed part without a
  stored entry fails the run.
- **Retry (error path).** With the provider key removed (or a prompt that
  fails), the turn ends in a `role="alert"` row "Turn failed." with
  `[data-testid="retry-{runId}"]`; clicking it re-sends the original prompt
  as a new run. Store `08-retry.png`. Skip when the backend is keyed and
  healthy — report the unmet precondition instead of forcing a failure.
- **Proof.** Store screenshots, the console record, the transcript with the
  network log, and the entries re-read in
  `artifacts/{RUN_ID}/web-thread/`.

## Gotchas

- The Worker must be up on 8787 (or `PUBLIC_WORKER_URL`): the app bootstraps
  against it on load and streams over a live WS; with the Worker down the
  page renders the bootstrap error block, not a thread.
- Unkeyed backend: `GET /models` returns an empty `keyed` list and the page
  shows the "No model provider key is set…" alert instead of a thread. Set
  the provider key as a Worker secret, redeploy, reload.
- Fresh session per load: there is no history to resume, and a reload
  orphans the previous session. Capture WS/SID from the network log of the
  same load you drive.
- `thread-item-{id}` values are mapper-generated and change between runs —
  assert on the `thread-item-` prefix, bubble alignment, and content, never
  on a hardcoded id.
- The assistant avatar appears only when a roster bot is selected
  (`activeId` set in `pi-do.roster.v1`); on a fresh profile the bubbles are
  avatar-less by design. The avatar is the active bot's, not per-message.
- `activity-row` renders only while the connection is open AND the last
  turn is streaming; it vanishes at settle. It is mid-stream evidence —
  capture it during the stream step, not after.
- The thread auto-scrolls only while pinned (within 64px of the bottom); a
  scrolled-up view stops following. Use the `scroll-to-bottom` pill (or
  scroll down) before asserting on the latest row.
- A turn that ran keyless renders a "Provider key required" error card with
  Retry instead of agent content — that is the designed mask, not a stream
  bug; `retry-{runId}` re-queues the same prompt over a fresh socket.
- Markdown is rendered per bubble by ChatMarkdown (react-markdown + GFM +
  breaks); single newlines become line breaks. Do not mistake a rendered
  `<br>` for a missing `\n\n` paragraph break.
