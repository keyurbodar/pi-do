# Chat UX surfaces

Grok-style extras around the core thread/composer: the blue NEW divider
that marks fixture playback of a fresh session, and the `?cards-demo=1`
widget gallery (file, code, choice, secret, and agent cards). The gallery
needs no backend; the NEW divider rides the normal fixture flow (see
[web-thread](./web-thread.md) for the thread itself,
[web-composer](./web-composer.md) for the reply strip).

## Sub-features

- `web-chat-ux-new` marks fixture playback of a fresh session: while
  playback is playing and no live turn exists yet, a centered blue NEW
  divider (`new-divider`, `role="separator"`, `aria-label="New"`,
  info-blue text with info-blue rules) renders above the first group. It
  vanishes when playback settles or once a live turn lands.
- `web-chat-ux-cards` renders the gallery at `?cards-demo=1`
  (`cards-demo`, no backend needed): `FileCard` (`file-card` with
  `file-download` + `file-open`) and `CodeBlock` (`code-block`,
  `code-language`, `code-copy`, `code-copied` sr-only confirmation).
- `web-chat-ux-choice` drives the `ChoiceWidget` (`choice-widget`,
  `choice-subtitle`): three default options as
  `choice-option-{index}`, a free-text `choice-input` with
  `choice-submit`, and `choice-answered` ("Picked: …") after picking.
- `web-chat-ux-secret` drives the `SecretCard` (`secret-card`):
  password `secret-input`, `secret-toggle` (aria-pressed show/hide),
  `secret-submit`, then `secret-stored` ("Key stored.").
- `web-chat-ux-agent` shows the `AgentCard` (`agent-card` with the
  `agent-status` pill, `data-state` reflecting `status`).

## How to get to it (user POV)

- Open `http://localhost:3000` in a browser.
- NEW divider: on a fresh load, click `roster-row-chief` in the sidebar
  (see [web-roster](./web-roster.md)). Chief carries a fixture script
  that auto-plays once per page load: the scripted prompt lands as a done
  user turn, then the bot turn streams. While it plays,
  `[data-testid="new-divider"]` sits above the first group — blue NEW
  text centered between two rules.
- Gallery: open `http://localhost:3000?cards-demo=1` (same demo-query
  pattern as `?bloub-demo=1`). `[data-testid="cards-demo"]` stacks one of
  each card: `file-card` ("report.pdf", "1.2 MB"), `code-block` (ts,
  `const hello = "world";`), `choice-widget` ("Pick a plan" /
  "Choose how to proceed"), `secret-card`, `agent-card`
  ("Research agent", running).
- Widget state is local: picking a choice, storing a key, or copying code
  never touches the backend.

## Driving it in the browser

Preconditions:

- The shared dev server answers at `http://localhost:3000` (never start
  your own instance on 3000 — see SKILL.md "Web surface").
- Browser automation with console capture attached before navigation; the
  console record is mandatory evidence for every pass.
- Each step below is one surface, one pass, under 60 seconds.

- **NEW divider.** Fresh-load `http://localhost:3000`, wait for the ready
  status line, click `roster-row-chief`. While the fixture plays,
  `[data-testid="new-divider"]` (blue, `role="separator"`) renders above
  the first group. Zero console errors; store `01-new-divider.png` and
  the console record.
- **Gallery.** Open `http://localhost:3000?cards-demo=1`.
  `[data-testid="cards-demo"]` shows all five cards; `file-card`,
  `code-block` (with `code-language` "ts"), `choice-widget`,
  `secret-card`, and `agent-card` (with `agent-status` reading the
  running state) are each present. Click `code-copy`: the sr-only
  `code-copied` confirmation appears. Store `02-cards.png`.
- **Choice + secret.** Still on the gallery: click `choice-option-0` —
  `choice-answered` reads "Picked: …". Reload, type into `choice-input`
  and submit via `choice-submit`: same answered state. Type a value into
  `secret-input`, toggle `secret-toggle` (input flips text/password),
  submit via `secret-submit`: `secret-stored` reads "Key stored.".
  Store `03-choice.png` and `04-secret.png`.
- **Proof.** Store screenshots, the console record, and the transcript in
  `artifacts/{RUN_ID}/web-chat-ux/`.

## Gotchas

- Fixture playback fires once per bot per page load (module-level played
  set): if `new-divider` never appears, reload the page before assuming a
  bug — the script already played.
- `new-divider` shows only while `playing` is true AND every turn is a
  fixture turn (`fixture:` runIds). Sending a live prompt mid-playback or
  letting the script settle removes it by design.
- The gallery needs no Worker and emits no network traffic: backend-down
  failures during the gallery steps are harness issues, not widget bugs.
- `choice-option-{index}` and `code-copy`/`secret-submit` are positional
  or single-instance in the demo — re-query after reload instead of
  caching handles.
- Reaction emoji (`message-react-option-*`) belong to the thread toolbar,
  not this gallery — drive them under
  [web-thread](./web-thread.md#driving-it-in-the-browser).
