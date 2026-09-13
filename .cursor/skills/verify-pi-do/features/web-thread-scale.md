# Thread scale: virtualized scroll and group runtime

Long-thread performance and group conversations: the thread renders only the
visible window while scrolling stays pinned, and offsite-crew turns stream
per-sender labels under the existing thread rows.

## Sub-features

- `virtual-window` `thread-viewport` is the scroll container; `thread-window` renders only the visible slice of `thread-item-{id}` rows.
- `virtual-scroll` existing `scroll-to-bottom` and `time-divider` keep working: overflow shows the pill, dividers split days/sessions.
- `group-labels` group exchanges reuse `thread-item-{id}` with per-sender `senderLabel` text — no new testid.
- `group-stream` per-sender streaming renders inside the same rows during an offsite-crew turn.

## How to get to it (user POV)

- Open `http://localhost:3000`, send enough prompts (or load a long session) that the thread overflows: only the visible slice sits in `thread-window` inside `thread-viewport`; scrolling up reveals `scroll-to-bottom`, and `time-divider` rows split the history.
- Select the `offsite-crew` group row and send a prompt: the exchange renders as `thread-item-{id}` rows carrying per-sender labels, streaming per sender while the turn runs.

## Driving it in the browser

Preconditions:

- Shared dev server on 3000, Worker reachable (Doctor exit `0`), keyed provider, fast pass `sh helpers/verify-ui.sh http://localhost:3000 artifacts/{RUN_ID}/web-thread-scale web-thread-scale` exits `0`.
- Console-error capture attached before navigation; the console record is mandatory evidence.

- **Window.** With an overflowing thread, evaluate `document.querySelectorAll('[data-testid^="thread-item-"]').length` inside `thread-window`: it stays bounded while the session holds more entries (entries API re-read proves the full count). Store `01-window.png`.
- **Scroll.** Scroll `thread-viewport` up: `scroll-to-bottom` appears; click it: the viewport re-pins and the pill disappears. `time-divider` rows remain at their positions. Store `02-scrolled.png` and `03-jumped.png`.
- **Group.** Select `roster-row-offsite-crew`, send a prompt: `thread-item-{id}` rows arrive with sender labels (e.g. Chief / Sales Outbound). Store `04-group.png` mid-stream and `05-group-settled.png`.
- **Proof.** Store screenshots, the console record, the transcript, and the entries re-read in `artifacts/{RUN_ID}/web-thread-scale/`. This feature is driven once per change — do not re-drive it from another pass.

## Gotchas

- Virtualization has no visual marker: assert via DOM count vs entries count, not via pixels. Both have no new testids by design — never assert on a guessed id.
- Group runtime reuses `thread-item-{id}` + `senderLabel`; per-message avatars still follow the active-bot rule, not the sender.
- The thread auto-scrolls only while pinned (within 64px of the bottom); a scrolled-up view stops following until the pill is clicked.
- Mid-stream group evidence must be captured during the stream; settled rows look like ordinary turns.
