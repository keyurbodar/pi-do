# Sidebar sheets: channels, memory, tools

Per-bot integration sheets: the user connects chat channels, curates long-term
memory entries, and toggles tool access with a usage bar — each sheet opening
from the bot row and persisting per bot.

## Sub-features

- `channels-open` a bot row opens `bot-channels-sheet` (brief alias `channels-sheet`).
- `channels-status` each provider shows `channel-status-{slack|gmail|discord}`.
- `channels-connect` `channel-connect-{slack|gmail|discord}` toggles connect/disconnect per provider.
- `memory-open` a bot row opens `bot-memory-sheet` (brief alias `memory-sheet`).
- `memory-add` `memory-input` + `memory-add` appends an entry rendered as `memory-item-{index}`.
- `memory-remove` `memory-remove-{index}` deletes that entry.
- `tools-open` a bot row opens `bot-tools-sheet` (brief alias `tools-sheet`).
- `tools-toggle` `tool-toggle-{salesforce|gmail|slack|hex|notion|gcal}` (brief alias `tool-toggle-{name}`) flips each tool.
- `tools-usage` `tool-usage-bar` (brief alias `usage-bar`) reflects enabled-tool usage.

## How to get to it (user POV)

- Open `http://localhost:3000`, wait for `roster-sidebar`.
- Right-click a `roster-row-{id}` and open its channels/memory/tools entries: `bot-channels-sheet` lists `channel-status-{provider}` rows each with a `channel-connect-{provider}` button; `bot-memory-sheet` shows `memory-input`, `memory-add`, and `memory-item-{index}` rows each with `memory-remove-{index}`; `bot-tools-sheet` shows `tool-toggle-{name}` switches under `tool-usage-bar`.

## Driving it in the browser

Preconditions:

- Shared dev server on 3000, fast pass `sh helpers/verify-ui.sh http://localhost:3000 artifacts/{RUN_ID}/web-sidebar-sheets web-sidebar-sheets` exits `0`.
- Console-error capture attached before navigation; the console record is mandatory evidence.
- Deterministic start: `localStorage.removeItem("pi-do.roster.v1")` then reload.

- **Channels.** Open `bot-channels-sheet` for `roster-row-chief`. Each `channel-status-{slack|gmail|discord}` shows its state; click `channel-connect-slack`: the status flips to connected (button now reads Disconnect). Click again to restore. Store `01-channels.png`.
- **Memory.** Open `bot-memory-sheet`. Type into `memory-input`, click `memory-add`: `memory-item-0` appears. Add a second entry, click `memory-remove-0`: the first entry disappears. Reload: remaining entries persist. Store `02-memory.png` and the storage dump.
- **Tools.** Open `bot-tools-sheet`. Toggle `tool-toggle-slack` off and on; `tool-usage-bar` updates. Reload: toggle states persist. Store `03-tools.png`.
- **Proof.** Store screenshots, the console record, the transcript, and the storage dump in `artifacts/{RUN_ID}/web-sidebar-sheets/`. This feature is driven once per change — do not re-drive it from another pass.

## Gotchas

- Track testids override the brief: `bot-channels-sheet`, `bot-memory-sheet`, `bot-tools-sheet`, `tool-usage-bar`. Accept the bare brief aliases (`channels-sheet`, `memory-sheet`, `tools-sheet`, `usage-bar`) when both render.
- Channel connects may need OAuth in live use — the drive asserts the toggle/status round-trip, never a real provider handshake.
- Memory indices are positional: re-read `memory-item-{index}` after every add/remove instead of caching them.
- Sheets are per-bot state; switching rows must show a different sheet, not a shared one.
