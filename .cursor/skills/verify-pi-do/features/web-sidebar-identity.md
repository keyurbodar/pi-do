# Sidebar identity: avatar picker and bot details

Bot identity editing: the user picks an avatar (bloub, upload, or generated
variant) in the New bot dialog and tunes a bot's voice, memory, sandbox, tools,
and usage cap from its details sheet — all persisted per bot.

## Sub-features

- `avatar-tabs` the New bot dialog offers `avatar-tab-bloub`, `avatar-tab-upload`, and `avatar-tab-identicon` (brief alias `avatar-tab-generated`).
- `avatar-upload` the upload tab exposes `avatar-upload-input` (file), `avatar-upload-preview`, and `avatar-upload-error` on bad files.
- `avatar-identicon` the generated tab offers `avatar-identicon-0/1/2` SVG options derived from the name hash (brief alias `avatar-variant-{n}`).
- `avatar-submit` `new-bot-create` submits with the chosen avatar, `new-bot-cancel` aborts; the new `roster-row-bot-…` carries the avatar.
- `new-bot-fields` the dialog also collects `new-bot-persona-input`, `new-bot-instructions-input`, and `new-bot-model-select` (brief aliases `new-bot-persona`, `new-bot-instructions`, `new-bot-model`).
- `details-open` the row menu `menu-details` opens `bot-details-sheet` (brief alias `bot-details-{id}`).
- `details-voice` `detail-voice-toggle` (alias `details-voice`) flips the bot's voice on/off.
- `details-memory` `detail-memory-input` + `detail-memory-add` appends a memory; each renders with `detail-memory-remove-{index}` (aliases `details-memory-add`, `details-memory-item-{i}`, `details-memory-delete-{i}`).
- `details-sandbox` `detail-sandbox-select` (alias `details-sandbox`) changes the sandbox mode.
- `details-tools` per-tool toggles `detail-tool-{salesforce|gmail|slack|hex|notion|gcal}` (alias `details-tool-{name}`).
- `details-cap` `detail-usage-cap-input` (alias `details-usage-cap`) edits the usage cap.

## How to get to it (user POV)

- Open `http://localhost:3000`. Click `new-bot-button` → `new-bot-menu-item`: `new-bot-dialog` opens with name input `new-bot-name-input`, persona `new-bot-persona-input`, instructions `new-bot-instructions-input`, model `new-bot-model-select`, and the three avatar tabs.
- Avatar tabs: `avatar-tab-bloub` shows the bloub picker; `avatar-tab-upload` shows `avatar-upload-input` with `avatar-upload-preview` after a file pick (or `avatar-upload-error` on reject); `avatar-tab-identicon` shows `avatar-identicon-0/1/2` options.
- `new-bot-create` confirms, `new-bot-cancel` closes without creating.
- Right-click any `roster-row-{id}` → `menu-details`: `bot-details-sheet` opens with the voice toggle, memory input+add, sandbox select, tool toggles, and usage-cap input.

## Driving it in the browser

Preconditions:

- Shared dev server on 3000, fast pass `sh helpers/verify-ui.sh http://localhost:3000 artifacts/{RUN_ID}/web-sidebar-identity web-sidebar-identity` exits `0`.
- Console-error capture attached before navigation; the console record is mandatory evidence.
- Deterministic start: `localStorage.removeItem("pi-do.roster.v1")` then reload.

- **Fields.** Open the New bot dialog; type name, persona, instructions; set `new-bot-model-select` to `grok-4`. Store `01-fields.png`.
- **Bloub.** On `avatar-tab-bloub`, pick a bloub; click `new-bot-create`. The new `roster-row-bot-…` appears selected with that avatar. Store `02-bloub.png`.
- **Upload.** Open the dialog again; on `avatar-tab-upload`, set `avatar-upload-input` to a PNG file: `avatar-upload-preview` appears. Submit: the row avatar matches. Store `03-upload.png`. Retry with a non-image file: `avatar-upload-error` appears and submit stays blocked.
- **Generated.** Open the dialog; on `avatar-tab-identicon`, click `avatar-identicon-1`. Submit: the row avatar is the generated SVG. Store `04-identicon.png`.
- **Details.** Right-click the created bot → `menu-details`. `bot-details-sheet` opens. Toggle `detail-voice-toggle`; type a memory into `detail-memory-input`, click `detail-memory-add` (entry appears with `detail-memory-remove-0`); change `detail-sandbox-select`; toggle `detail-tool-slack`; set `detail-usage-cap-input`. Reload: all values persist. Store `05-details.png` and the storage dump.
- **Proof.** Store screenshots, the console record, the transcript, and the storage dump in `artifacts/{RUN_ID}/web-sidebar-identity/`. This feature is driven once per change — do not re-drive it from another pass.

## Gotchas

- Track testids override the brief: `avatar-tab-identicon` (not `avatar-tab-generated`), `avatar-identicon-{n}` (not `avatar-variant-{n}`), `new-bot-persona-input` / `new-bot-instructions-input` / `new-bot-model-select`, `detail-*` (not `details-*`), `bot-details-sheet` (not `bot-details-{id}`). Accept either spelling when both render.
- Upload errors are synchronous validation — pick a real bad file rather than asserting on an empty input.
- Identicon options derive from the name hash: type the name before asserting which variants render.
- `menu-details` is a row-menu item alongside `menu-pin`/`menu-delete`; open it with a right-click, not the removed hover ellipsis.
- Details persist into `pi-do.roster.v1` per bot — verify the dump after reload, not just the open sheet.
