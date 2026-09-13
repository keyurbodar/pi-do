# Composer

The prompt composer at the bottom of the web app: a pill-shaped block with a
textarea (`composer-input`), a stash button for parking drafts, an attach
button with a staged-attachment strip, a UI-only mic toggle (pulsing
recording state + timer, no audio anywhere), a reply strip above the field
when a bubble reply is armed, and a send button that is disabled while empty
and stays Send (disabled) while a turn runs — there is no Stop button;
Escape is the only abort path. Text drafts and stashed prompts persist to
localStorage per draft key (`pi-do-draft-{draftKey}` /
`pi-do-stash-{draftKey}`, default bucket `default`).

## Sub-features

- `composer-type` accepts text in the textarea; the placeholder ("Message
  {bot name}") shows only while empty, and every keystroke persists the
  draft.
- `composer-draft` persists the draft under `pi-do-draft-{draftKey}`
  (default key `pi-do-draft-default`): restored on load, cleared on send,
  truncated at 20 000 chars.
- `composer-send-state` gates the send button: `disabled` when empty,
  enabled with text, always `aria-label="Send"` with
  `data-status="ready"` — it never morphs into Stop; while a turn runs it
  stays Send (disabled) and Escape is the only abort path (`onAbort`).
- `composer-abort` fires `onAbort` on Escape while streaming; the turn ends
  interrupted with a Retry affordance (`retry-{runId}`, see
  [web-thread](./web-thread.md)).
- `composer-stash` parks the current draft: with text it saves the trimmed
  draft to `pi-do-stash-{draftKey}` (max 10 entries, newest first), clears
  the input, and opens the menu; with an empty input it toggles the
  `stash-menu`.
- `composer-attach` stages files (button or paste onto the textarea) as
  `composer-attachment` thumbnails; `attachment-remove-{id}` removes one;
  staged attachments clear on send.
- `composer-mic` is a UI-only voice toggle: clicking it flips `recording`
  (`aria-pressed`, aria-label "Voice input" / "Stop voice input") with a
  pulsing timer row (`mic-recording` + `mic-stop`, "Stop"); on browsers
  without `getUserMedia` it shows the `mic-unavailable` notice instead. No
  audio is captured anywhere.
- `composer-approval` renders the pending-approval card with
  Approve / Approve with edit / Reject buttons when the session surfaces a
  pending approval (staged — not yet emitted by live turns).
- `composer-reply` shows the armed-reply strip (`composer-reply-preview`,
  "Replying to {label}: …" with a `reply-dismiss` X) above the field; the
  sent prompt carries the reply (`{ reply: { label, text } }` submit opt)
  and sending consumes the target. Armed from any bubble's
  `message-reply-{id}` (see [web-thread](./web-thread.md));
  `reply-dismiss` clears it without sending.

## How to get to it (user POV)

- Open `http://localhost:3000`, wait for the ready thread (see
  [web-thread](./web-thread.md)).
- The composer is the footer `.composer` block, `[data-testid="composer"]`:
  the field is `[data-testid="composer-input"]` (a `<textarea>`, aria-label
  "Message {bot name}"); bottom-left row is `composer-stash` (bookmark icon,
  aria-label "Stash prompt") then `composer-attach` (plus icon, aria-label
  "Add attachment") and `composer-send` (`aria-label` "Send",
  `data-status="ready"` at all times — there is no Stop state).
- Staged attachments render as a thumbnail strip above the field, each with
  an `attachment-remove-{id}` X button (ids are
  `composer-attachment-{n}`, n counting up per staged file).
- An armed reply renders `composer-reply-preview` above the field
  ("Replying to {label}: {text}", truncated) with a `reply-dismiss` X
  (`aria-label` "Dismiss reply").
- The stash popup (`stash-menu`, role menu) lists entries as
  `stash-item-{index}` (newest first, 90-char snippet, full text on hover)
  with a `stash-delete-{index}` X per entry, or "Nothing stashed" when
  empty.
- localStorage keys: draft `pi-do-draft-{draftKey}`, stash
  `pi-do-stash-{draftKey}` (JSON array of `{id, text, createdAt}`); the app
  never sets `draftKey`, so both use the `default` bucket today.

## Driving it in the browser

Preconditions:

- Same as web-thread: shared dev server on 3000, Worker reachable (Doctor
  exit `0`), keyed provider, `helpers/web-check.sh` exit `0`, console
  capture attached before navigation; the console record is mandatory
  evidence for every pass.
- Each step below is one surface, one pass, under 60 seconds.

- **Type.** Focus `composer-input` and type `hello`. The placeholder
  disappears and `composer-send` becomes enabled (`data-status="ready"`).
  Evaluate `localStorage.getItem("pi-do-draft-default")` — it equals the
  typed text. Store `01-typed.png` and the storage dump.
- **Empty gate.** Clear the field: `composer-send` is `disabled` and
  clicking it does nothing (thread unchanged); the draft key is removed
  from localStorage. Store `02-empty.png`.
- **Send via button.** Type `say ok`, click `composer-send`. The field and
  the draft key clear, a user bubble appears, and the button stays
  `aria-label="Send"` / `data-status="ready"` (disabled while the turn
  runs). Store `03-running.png`.
- **Abort.** While streaming, press Escape. The turn ends interrupted (the
  interrupted error card with Retry) and the button returns to enabled
  Send. Store `04-aborted.png`. Second view: the entries replay shows the
  `interrupted` marker for that run.
- **Enter-to-send.** Type `say ok again` and press Enter (no Shift): same
  send path as the button. Shift+Enter inserts a newline instead of
  sending (the field grows, nothing is submitted). Store `05-enter.png`.
- **Stash.** Type `hold this thought`, click `composer-stash`: the field
  clears, `stash-menu` opens showing the entry as `stash-item-0`, and
  `pi-do-stash-default` holds one `{id, text, createdAt}` entry. Reload the
  page, click `composer-stash` (empty input toggles the menu), click the
  `stash-item-0` snippet: the text returns to `composer-input` and
  `pi-do-draft-default` is restored while the stash entry is consumed.
  Store `06-stashed.png` and `07-restored.png`.
- **Stash delete.** Stash a second entry, open the menu, click
  `stash-delete-0`: the entry disappears and the storage array shrinks.
  With the stash empty the menu shows "Nothing stashed". Store
  `08-stash-deleted.png`.
- **Attach.** Use `composer-attach` (or paste an image file onto the
  textarea): a `composer-attachment` thumbnail appears with an
  `attachment-remove-composer-attachment-1` X button. Click the X — the
  thumbnail is removed. Re-stage one file and send: the strip clears with
  the field. Store `09-attached.png` and `10-attached-sent.png`.
- **Mic.** Click `composer-mic`: on a mic-capable browser the
  `mic-recording` timer row appears with `mic-stop` ("Stop"); click
  `mic-stop` to end it — no audio is captured. On a browser without
  `getUserMedia`, clicking shows the `mic-unavailable` notice instead.
  Store `11-mic.png`.
- **Reply strip.** Hover an assistant bubble in the thread and click its
  `message-reply-{id}` control: `composer-reply-preview` appears above the
  field ("Replying to {label}: …"). Type `noted` and send — the new user
  bubble carries the quote block. Arm again, click `reply-dismiss`: the
  strip clears and the next send carries no quote. Store `12-reply.png`
  and `13-reply-dismissed.png`.
- **Approval card (staged).** When a pending approval surfaces, the
  composer area shows `[data-testid="approval-card"]` (aria-label
  "Approval required") with `approval-reject`, `approval-approve-edit`,
  `approval-approve` buttons. Not yet emitted by live turns — verify only
  if the approval wiring has landed; otherwise report the unmet
  precondition.
- **Proof.** Store screenshots, the console record, the transcript, the
  localStorage dumps, and the entries re-read in
  `artifacts/{RUN_ID}/web-composer/`.

## Gotchas

- `composer-input` is a `<textarea>`, not `contentEditable`: set its value
  by typing or `insertText`, not by assigning `.value` (React controlled
  input ignores it).
- Send is gated on trimmed text — whitespace-only input keeps the button
  disabled.
- IME composition (keyCode 229) suppresses Enter-send; do not read a
  non-send during composition as a bug.
- There is no Stop button: while running, `composer-send` stays Send
  (`disabled={!hasText}`, so an empty field keeps it disabled mid-run too).
  An "abort button" assertion always fails — abort is Escape-only.
- Abort needs a turn that is still running: short prompts settle before the
  Escape keypress lands. Use a long prompt for the abort step.
- After an abort the turn shows the interrupted card with Retry; Retry
  re-queues the same prompt — that is web-thread behavior, not a composer
  bug.
- The reply strip renders only while a reply is armed (bubble
  `message-reply-{id}` or the `replyStore` target): assert
  `composer-reply-preview` presence only after arming, and absence after
  `reply-dismiss` or a quoted send (sending consumes the target).
- Stash and draft are separate buckets: stashing clears the draft key, and
  restoring moves the entry back into the draft. Deleting a stash entry
  never touches the current draft text.
- Stash entries are capped at 10 (newest kept); `stash-item-{index}` and
  `stash-delete-{index}` are positional — re-read the menu after every
  mutation instead of caching indices.
- Attachment ids are session-scoped (`composer-attachment-1`, `-2`, …) and
  never reset while the page is loaded; build the remove-button testid from
  the staged thumbnail's actual id, not a guessed counter.
- Draft/stash persistence is best-effort: in private-mode or quota-error
  contexts the keys silently vanish — verify storage in the same context
  you drive.
- `pidof-draft-default` is a legacy App-level write (bubble-edit remount
  path) that PromptInput never reads — the live draft contract is
  `pi-do-draft-{draftKey}`. Bubble edit affordances were removed, so that
  path is dead; assert storage against the `pi-do-draft-` key only.
- The field's aria-label and placeholder embed the active bot's name; with no
  roster bot selected App passes `undefined`, so the label reads literally
  "Message undefined". Select a bot first (web-roster) or assert on
  `data-testid="composer-input"` instead of the label.
