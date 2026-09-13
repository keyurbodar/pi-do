# Thread actions: message actions, delegation, step meter, input prompts, approvals, header

Turn-level thread controls: per-message actions, delegation cards, live step
counts, structured user-input prompts, approval decisions, and header utilities
— each with an observable settled state.

## Sub-features

- `message-actions` hovering a `thread-item-{id}` reveals `message-actions-{itemId}` with `message-copy-{itemId}`, `message-retry-{itemId}`, `message-edit-{itemId}` (brief aliases `msg-copy-{id}`, `msg-retry-{id}`, `msg-edit-{id}`); copy shows `message-copied-{itemId}` feedback.
- `delegation-card` `delegation-card-{id}` renders a delegated turn with `delegation-status-{id}` pill inside (alias `delegation-status`).
- `step-meter` `step-meter-{runId}` (alias `step-meter`) reads `Step N · M tool calls` above the activity row while streaming.
- `user-input` `userinput-card-{id}` (alias `user-input-{id}`) offers `userinput-option-{id}-{i}` buttons (alias `user-input-option-{i}`), a `userinput-text-{id}` field, and `userinput-submit-{id}` (alias `user-input-submit`); answering shows `userinput-answered-{id}`.
- `approvals` `approval-card-{id}` (existing `approval-card` kept) with `approval-approve-{id}` / `approval-reject-{id}`; deciding shows `approval-decided-{id}`.
- `header-actions` `chat-header` carries `header-avatar` and `header-presence` plus `header-scroll-bottom`, `header-copy-transcript`, `header-new-turn`; copying shows `header-copied`.

## How to get to it (user POV)

- Open `http://localhost:3000`, send a prompt so `thread-item-{id}` rows exist.
- Hover any row: `message-actions-{itemId}` appears with copy/retry/edit buttons; clicking copy shows `message-copied-{itemId}`.
- Delegated turns render `delegation-card-{id}` with the `delegation-status-{id}` pill; streaming turns show `step-meter-{runId}` above the activity row.
- Model-asked input renders `userinput-card-{id}` (option buttons, text field, submit); answering flips it to `userinput-answered-{id}`.
- Approval turns render `approval-card-{id}` with approve/reject; deciding shows `approval-decided-{id}`.
- The thread header `chat-header` holds the avatar, presence, and the scroll-bottom / copy-transcript / new-turn buttons.

## Driving it in the browser

Preconditions:

- Shared dev server on 3000, Worker reachable (Doctor exit `0`), keyed provider, fast pass `sh helpers/verify-ui.sh http://localhost:3000 artifacts/{RUN_ID}/web-thread-actions web-thread-actions` exits `0`.
- Console-error capture attached before navigation; the console record is mandatory evidence.

- **Actions.** Hover a settled assistant `thread-item-{id}`: `message-actions-{itemId}` appears. Click `message-copy-{itemId}`: `message-copied-{itemId}` feedback shows. Click `message-retry-{itemId}`: the turn re-queues. Click `message-edit-{itemId}`: the prompt returns to the composer for editing. Store `01-actions.png` and `02-copied.png`.
- **Delegation.** Prompt a delegated turn: `delegation-card-{id}` renders and `delegation-status-{id}` moves to done at settle. Store `03-delegation.png`. Skip with unmet precondition when delegation is not staged — report it.
- **Step meter.** While streaming, `step-meter-{runId}` reads `Step N · M tool calls` above the activity row. Store `04-step.png` mid-stream.
- **User input.** With a staged question, `userinput-card-{id}` shows options and `userinput-text-{id}`; click `userinput-option-{id}-0` (or type + `userinput-submit-{id}`): `userinput-answered-{id}` replaces the card. Store `05-input.png`. Skip with unmet precondition when no prompt is staged.
- **Approvals.** With a staged approval, click `approval-approve-{id}` (or `approval-reject-{id}`): `approval-decided-{id}` confirms the decision. Store `06-approval.png`. Skip with unmet precondition when no approval is staged.
- **Header.** Click `header-copy-transcript`: `header-copied` feedback shows. Click `header-scroll-bottom`: the viewport pins to the tail. Click `header-new-turn`: a fresh turn starts. Store `07-header.png`.
- **Proof.** Store screenshots, the console record, and the transcript in `artifacts/{RUN_ID}/web-thread-actions/`. This feature is driven once per change — do not re-drive it from another pass.

## Gotchas

- Track testids override the brief: `message-copy/retry/edit-{itemId}` (not `msg-*-{id}`), `delegation-status-{id}`, `step-meter-{runId}`, `userinput-*` (no hyphen), `approval-approve/reject/decided-{id}`. Accept the brief aliases when both render.
- `message-actions-{itemId}` shows on hover only — hover the row before asserting; headless drivers must move the pointer, not just query.
- Copy feedback (`message-copied-{itemId}`, `header-copied`) is transient; assert it immediately after the click.
- Delegation, user-input prompts, and approvals are staged by the session, not always live — report the unmet precondition instead of forcing the state.
- `message-retry-{itemId}` re-queues over a fresh socket; the new run gets a new id — assert the new row, not the old one.
