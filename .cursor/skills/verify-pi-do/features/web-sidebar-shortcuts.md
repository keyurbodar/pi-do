# Sidebar shortcuts and drag-drop

Keyboard-first sidebar control plus drag-drop roster ordering: the user never
needs the mouse to find, open, pin, or delete a bot, and reorders rows by
dragging them — the order persists across reloads.

## Sub-features

- `shortcuts-focus` cmd/ctrl+k focuses `roster-search` from anywhere in the app.
- `shortcuts-move` j/k and arrow keys move the selection across `roster-row-{id}` rows.
- `shortcuts-open` Enter selects the highlighted row (same as clicking it).
- `shortcuts-new` n opens `new-bot-dialog`.
- `shortcuts-rail` e toggles `rail-toggle` (collapse/expand the sidebar).
- `shortcuts-pin` p pins/unpins the highlighted bot via `menu-pin`.
- `shortcuts-delete` Delete opens `delete-confirm-dialog` for the highlighted row.
- `dnd-row` every `roster-row-{id}` is `draggable="true"`.
- `dnd-indicator` dragging shows `drop-indicator` (brief alias `drop-indicator-{id}`) at the drop position.
- `dnd-persist` the dropped order persists via `moveItem`/`reorder` and survives reload (`pi-do.roster.v1`).

## How to get to it (user POV)

- Open `http://localhost:3000`, wait for `[data-testid="roster-sidebar"]`.
- Press cmd/ctrl+k: `roster-search` gains focus. Type to filter, Escape clears.
- With the sidebar focused, press j/k or Up/Down: the highlighted `roster-row-{id}` moves.
- Press Enter: the highlighted row selects (`aria-current="true"`, thread header updates).
- Press n: `new-bot-dialog` opens. Press e: the sidebar collapses to the rail and back.
- Highlight a bot, press p: it pins/unpins (Pinned area appears at the top).
- Highlight a row, press Delete: `delete-confirm-dialog` opens (`delete-confirm` confirms, `delete-cancel` aborts).
- Drag any `roster-row-{id}` over another row: `drop-indicator` line appears; dropping reorders the list.

## Driving it in the browser

Preconditions:

- Shared dev server on 3000, `sh helpers/verify-ui.sh http://localhost:3000 artifacts/{RUN_ID}/web-sidebar-shortcuts web-sidebar-shortcuts` exits `0` (fast pass first).
- Console-error capture attached before navigation; the console record is mandatory evidence.
- Deterministic start: `localStorage.removeItem("pi-do.roster.v1")` then reload.

- **Focus.** Press cmd/ctrl+k. `roster-search` is focused. Store `01-focus.png`.
- **Move + open.** Press j twice, then Enter. The highlighted `roster-row-{id}` gains `aria-current="true"` and the thread header shows its name. Store `02-open.png`.
- **New.** Press n. `new-bot-dialog` is visible; Escape closes it. Store `03-new.png`.
- **Rail.** Press e. `roster-sidebar` flips `data-collapsed` to `true`; press e again to restore. Store `04-rail.png` and `05-rail-back.png`.
- **Pin.** Highlight `roster-row-inbox-manager`, press p. The Pinned header appears; press p again to unpin. Store `06-pin.png`.
- **Delete.** Highlight a created bot row, press Delete. `delete-confirm-dialog` appears; click `delete-cancel` to abort (row stays), or `delete-confirm` to remove it. Store `07-delete.png`.
- **Drag.** Drag `roster-row-chief` below `roster-row-sales-outbound`: `drop-indicator` appears mid-drag; on drop the order changes. Reload: the new order persists (`pi-do.roster.v1` dump matches). Store `08-drag.png` and the storage dump.
- **Proof.** Store screenshots, the console record, the transcript, and the storage dump in `artifacts/{RUN_ID}/web-sidebar-shortcuts/`. This feature is driven once per change — do not re-drive it from another pass.

## Gotchas

- Shortcuts are keyboard-only: there are no buttons for them, so assert on focus/selection state, not on visible controls.
- cmd+k vs ctrl+k is platform-dependent; use `ControlOrMeta` and verify the focused element.
- j/k move the highlight, not the selection — Enter commits it. Do not assert `aria-current` before Enter.
- `drop-indicator` may render without the `{id}` suffix the brief names; assert on the `drop-indicator` prefix.
- Drag-drop needs a real pointer drag (`dragAndDrop`), not a click; a click only selects.
- Order persistence goes through `moveItem`/`reorder` into `pi-do.roster.v1` — verify the dump, not just the screen.
