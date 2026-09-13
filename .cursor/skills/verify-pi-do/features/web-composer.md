# Composer

The prompt composer at the bottom of the web app: a contentEditable field
with placeholder, a send button that is disabled while empty and morphs into
Stop while a turn runs, and Enter-to-send.

## Sub-features

- `composer-type` accepts text in the field; the placeholder shows only while empty and unfocused.
- `composer-send-state` gates the send button: disabled when empty and idle, enabled with text, `data-status` flips `ready` → `streaming` while running.
- `composer-send` sends on Enter (without Shift) or on the send button, and clears the field.
- `composer-abort` turns the send button into Stop while streaming; clicking it aborts the run and the turn ends interrupted with a Retry affordance.

## How to get to it (user POV)

- Open `http://localhost:3000`, wait for the ready thread (see
  [web-thread](./web-thread.md)).
- The composer is the footer `.composer` block: the field is
  `[role="textbox"][aria-label="Ask AI Agent"]` (`data-placeholder="Ask AI
  Agent"`, `data-empty` set while empty and unfocused); the send/stop button
  sits at the row's right end (`aria-label="Send"` or `"Stop"`, `data-status`
  `ready`|`streaming`); the left plus button is present but disabled
  (title: "Attachments and models are not available yet").

## Driving it in the browser

Preconditions:

- Same as web-thread: shared dev server on 3000, Worker reachable (Doctor
  exit `0`), keyed provider, `helpers/web-check.sh` exit `0`, console
  capture attached before navigation.

- **Type.** Focus the field and type `hello`. The placeholder disappears
  (`data-empty` unset once focused or typed) and the send button becomes
  enabled with `aria-label="Send"`. Store `01-typed.png`.
- **Empty gate.** Clear the field: the send button is `disabled` and
  clicking it does nothing (thread unchanged). Store `02-empty.png`.
- **Send via button.** Type `say ok`, click `[aria-label="Send"]`. The field
  clears, a user bubble appears, and the button flips to
  `aria-label="Stop"` / `data-status="streaming"` while the turn runs.
  Store `03-running.png`.
- **Abort.** While streaming, click the Stop button. The turn ends
  interrupted: the fold row reads "You stopped after Ns" (or the
  interrupted error card with Retry) and the button returns to
  `aria-label="Send"` / `data-status="ready"`. Store `04-aborted.png`.
  Second view: the entries replay shows the `interrupted` marker for that
  run.
- **Enter-to-send.** Type `say ok again` and press Enter (no Shift): same
  send path as the button. Shift+Enter inserts a newline instead of
  sending. Store `05-enter.png`.
- **Proof.** Store screenshots, the console record, the transcript, and the
  entries re-read in `artifacts/{RUN_ID}/web-composer/`.

## Gotchas

- The field is `contentEditable`, not an `<input>`/`<textarea>`: set its
  value by typing or `insertText`, not by assigning `.value`.
- Send is gated on trimmed text — whitespace-only input keeps the button
  disabled.
- IME composition (keyCode 229) suppresses Enter-send; do not read a
  non-send during composition as a bug.
- Abort needs a turn that is still running: short prompts settle before you
  can click Stop. Use a long prompt for the abort step.
- After an abort the turn shows the interrupted card with Retry; Retry
  re-queues the same prompt — that is web-thread behavior, not a composer
  bug.
