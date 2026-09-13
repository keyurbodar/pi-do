# Bot roster

The left sidebar of the web app: the user sees their bots and groups as
iMessage-style rows (avatar, name, relative timestamp, one-line preview,
presence, unread badge), searches them, pins favorites, deletes entries,
creates bots/groups/sections from the plus menu, collapses the sidebar to an
icon rail, and selects a bot to address it. State persists to localStorage.

## Sub-features

- `roster-view` renders the seeded roster: six bots and one group ("Offsite
  crew") as rows with avatar, name, relative timestamp, one-line preview,
  presence marker, and unread badge.
- `roster-search` filters the list live from `roster-search`; a non-empty
  query flattens the list (matching groups first, then bots — no pinned area,
  no sections) and a no-hit query shows "No bots match"; Escape clears.
- `roster-pin` pins/unpins a bot from its row menu; pinned bots collect under
  a "Pinned" header at the top, most recent first, with a pin icon on the row.
- `roster-delete` deletes a bot, group, or section from its menu; deleting a
  bot also removes it from every group and section and clears the selection
  if it was active.
- `roster-create-bot` creates a bot via the plus menu and the New bot dialog
  (name + shape/color/expression identity pickers); the new bot is appended
  and selected.
- `roster-create-group` creates a group via the New group dialog (name plus a
  multi-select of ≥ 2 member bots).
- `roster-create-section` creates a section via the plus menu (native
  `window.prompt` for the name); sections render as collapsible headers with
  a member count and accept moved rows.
- `roster-rail` collapses the sidebar to a 56px avatar-only rail and back
  with `rail-toggle`; the collapsed rail keeps rows clickable.
- `roster-select` selects a row (`aria-current`), pointing the thread header
  title and the assistant bubble avatar at that bot.

## How to get to it (user POV)

- Open `http://localhost:3000` in a browser. The sidebar is the left column,
  `[data-testid="roster-sidebar"]` with `data-collapsed="false"`.
- Seed roster on first load (no persisted state): bots `chief` (Chief),
  `sales-outbound` (Sales Outbound — typing, 2 unread), `inbox-manager`
  (Inbox Manager — 1 unread), `account-manager` (Account Manager),
  `talent-scout` (Talent Scout), `expense-manager` (Expense Manager —
  sleeping), plus group `offsite-crew` (Offsite crew). No sections.
- Sidebar header, left to right: `rail-toggle` (Collapse sidebar),
  `roster-search` (placeholder "Search"), `new-bot-button` (aria-label
  "Create", plus icon).
- Every bot/group row is `roster-row-{id}`; hovering a row reveals
  `row-actions-{id}` (aria-label "Actions for {name}"); right-clicking a row
  opens the same floating menu. Section headers expose
  `section-actions-{name}`.
- Row menu items: `menu-pin` (bots only, "Pin"/"Unpin"), `menu-move-{sectionId}`
  (one per existing section, plus "No section" when the row is in one),
  `menu-delete` ("Delete", or "Delete section" for a section header).
- Plus menu (`roster-create-menu`): `new-bot-menu-item`, `new-group-menu-item`,
  `new-section-menu-item`.
- Everything persists to localStorage key `pi-do.roster.v1` as
  `{ bots, groups, sections, activeId, railCollapsed, collapsedSections }`.

## Driving it in the browser

Preconditions:

- The shared dev server answers at `http://localhost:3000` (never start your
  own instance on 3000 — see SKILL.md "Web surface").
- `sh helpers/web-check.sh` passes (exit `0`) before the first drive step.
- Console-error capture attached before navigation; the console record is
  mandatory evidence for every pass.
- Deterministic start: evaluate
  `localStorage.removeItem("pi-do.roster.v1")` in the page and reload, so the
  seed roster is showing rather than a previous run's mutations.

- **Open.** Navigate to `http://localhost:3000`. Wait for
  `[data-testid="roster-sidebar"][data-collapsed="false"]`; count seven
  `[data-testid^="roster-row-"]` rows (six bots + `roster-row-offsite-crew`).
  Zero console errors; store `01-open.png` and the console record.
- **Select.** Click `roster-row-chief`. The row gains `aria-current="true"`
  and the thread header above the chat shows "Chief". Store `02-select.png`.
- **Search.** Type `sales` into `roster-search`. Only
  `roster-row-sales-outbound` remains (groups match first, then bots; the
  Pinned area and section headers are gone while searching). Type `zzz`
  instead and the list shows "No bots match". Press Escape in the field to
  clear; the full list returns. Store `03-search.png` and `04-no-match.png`.
- **Pin.** Hover `roster-row-inbox-manager`, click
  `row-actions-inbox-manager`, then `menu-pin` (label "Pin"). A "Pinned"
  header with count appears at the top of the list and the row moves under
  it with a pin icon. Click `menu-pin` again ("Unpin") to restore. Store
  `05-pinned.png`.
- **Create bot.** Click `new-bot-button`, then `new-bot-menu-item` inside
  `roster-create-menu`. The `new-bot-dialog` opens; type `Verify Bot` into
  `new-bot-name-input`, pick `new-bot-shape-triangle`,
  `new-bot-color-rouge`, `new-bot-expression-curieux`, click
  `new-bot-create`. The dialog closes, a new row `roster-row-bot-…` appears
  (row count 8), it is selected (`aria-current="true"`), and the thread
  header shows "Verify Bot". Store `06-new-bot.png`.
- **Create group.** Click `new-bot-button` → `new-group-menu-item`. In
  `new-group-dialog`, type `Verify Crew` into `new-group-name-input`; the
  first two bots are pre-checked — toggle one more
  `new-group-member-{botId}` if desired — and click `new-group-create`. A
  `roster-row-group-…` row appears whose preview line lists the member
  names. Store `07-new-group.png`.
- **Create section and move.** Click `new-bot-button` →
  `new-section-menu-item`. The browser shows a native `window.prompt`
  ("Section name") — answer it with `Verify Section`. A section header
  appears with count 0 and a `section-actions-Verify Section` button. Move a
  bot into it: `row-actions-{botId}` → `menu-move-{sectionId}`; the section
  count increments and the row renders under the header. Click the section
  header: `aria-expanded` flips and the children hide/show. Store
  `08-section.png`.
- **Delete.** Open `row-actions-{botId}` on the created bot and click
  `menu-delete`: the row disappears and the section count drops. Open
  `section-actions-Verify Section` → `menu-delete` (label "Delete
  section"): the header disappears. Store `09-deleted.png`.
- **Rail.** Click `rail-toggle`. The sidebar becomes
  `[data-testid="roster-sidebar"][data-collapsed="true"]`: a 56px column of
  round avatars (still `roster-row-{id}`, `title` = bot name) with
  `rail-toggle` (aria-label "Expand sidebar") at the top. Click a rail avatar
  — it selects the bot. Click `rail-toggle` again; the full sidebar returns.
  Store `10-rail.png` and `11-rail-expanded.png`.
- **Persistence.** With mutations on screen, evaluate
  `JSON.parse(localStorage.getItem("pi-do.roster.v1"))` and store the dump
  as `roster-state.json`: `bots`/`groups`/`sections`/`activeId`/
  `railCollapsed`/`collapsedSections` match the screen. Reload the page —
  the mutated roster (or the rail state) is restored, not the seed.
- **Proof.** Store screenshots, the console record, the localStorage dump,
  and the transcript in `artifacts/{RUN_ID}/web-roster/`.

## Gotchas

- Presence is fixture data, not live: Sales Outbound renders the three-dot
  "Typing…" state, Expense Manager is "sleeping" (row dimmed to 60% opacity),
  and a "working" bot would show a green status dot. Nothing changes presence
  during a drive — never wait for a presence transition.
- The Pinned area exists only when at least one bot is pinned, and only in
  the un-searched list. Searching flattens the list: pinned rows lose their
  area, sections disappear, and results render groups first, then bots.
- `new-section-menu-item` opens a native `window.prompt`. Headless drivers
  must register a dialog handler before clicking it, or the step hangs the
  page. Cancelled prompt (null) or an empty name creates nothing.
- Group creation requires a non-empty name and at least two distinct members;
  the dialog pre-selects the first two bots, so unchecking below two leaves
  `new-group-create` disabled.
- Deleting the active bot or group clears the selection and the thread header
  reverts to "pi-do"; the thread session itself is untouched.
- Selecting a bot changes only the header title and the assistant avatar —
  there is no per-bot conversation yet; every selection shares the same
  session created at page load.
- `rail-toggle` is the same testid in both states (collapse button in the
  expanded header, expand button at the top of the rail). Assert state via
  `[data-testid="roster-sidebar"]` `data-collapsed`, not by counting toggles.
- Roster state survives reloads via `pi-do.roster.v1`. A corrupt or missing
  key silently falls back to the seed roster — an unexpected roster mid-run
  usually means a previous run's storage, so reset the key and reload.
