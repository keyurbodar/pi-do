# Composer new surfaces

The composer grows from a send box into a working surface: per-draft model
picking, slash commands and @-mentions, reply quoting, pending-question chips,
staged-attachment context display, banner stack, character/context meters, count
badges, size-based compression feedback, and voice input.

## Sub-features

- `model-picker` `composer-model-button` opens `composer-model-menu`; `composer-model-option-{default|claude-opus|gpt-5|grok-4}` picks the per-draft model (brief aliases `composer-model`, `model-option-{id}`), passed as the `onSubmit` second arg.
- `slash-menu` leading `/` opens `composer-slash-menu`; `slash-option-{search|summarize|plan|mention}` (alias `slash-item-{cmd}`) inserts the command text (`mention` inserts `@bot-name`).
- `mention-menu` `@` opens `composer-mention-menu`; `mention-option-{name}` (alias `mention-item-{bot}`) inserts `@name` from the `bots` prop.
- `reply-preview` `composer-reply-preview` (alias `reply-preview`) quotes the `replyTo` message; `reply-dismiss` clears it.
- `pending-banner` `composer-question-banner` (alias `pending-question`) wraps the pending question; `question-option-{i}` (alias `pending-option-{i}`) chips call `onAnswer(option)`.
- `context-chips` staged files render as `composer-attachment` chips (icon+name+size) with `attachment-remove-{id}`; brief-named `context-chip-{id}` accepted when rendered.
- `banners` `composer-banners` stacks `banner-{id}` entries (`data-kind` names the kind); `banner-dismiss-{id}` dismisses one.
- `meter` `composer-char-count` (alias `composer-count`) shows `N / 8000` with warn color past cap; `composer-context-meter` + `composer-context-meter-bar` (alias `context-meter`) is the thin width-% bar.
- `badges` `composer-tasks-badge` (alias `tasks-badge`) shows the staged-attachment count and `composer-stash-badge` (alias `stash-badge`) the stash count, both pulsing on change.
- `compression` has no testid: oversized staged images shrink (thumbnail byte size drops) before send.
- `voice` `composer-mic` toggles recording; `mic-recording` wraps the recording state with a pulsing red dot; `mic-timer` (alias `mic-elapsed`) shows elapsed `mm:ss`; `mic-stop` ends recording; `mic-unavailable` is the fallback text when `getUserMedia` is missing.

## How to get to it (user POV)

- Open `http://localhost:3000`, wait for the ready thread; the footer is `[data-testid="composer"]`.
- Click `composer-model-button`: `composer-model-menu` opens with `composer-model-option-*` rows; picking one changes the button label for this draft only.
- Type `/` first in `composer-input`: `composer-slash-menu` opens with `slash-option-*`; type `@`: `composer-mention-menu` opens with `mention-option-{name}` rows from the roster.
- With a `replyTo` set, `composer-reply-preview` quotes it above the field (`reply-dismiss` X clears).
- With a pending question, `composer-question-banner` shows `question-option-{i}` chips; clicking one answers.
- Stage a file: a `composer-attachment` chip (icon+name+size) appears; banners stack in `composer-banners` as `banner-{id}` with `banner-dismiss-{id}`.
- The footer shows `composer-char-count`, the `composer-context-meter` bar, `composer-tasks-badge` and `composer-stash-badge`; `composer-mic` starts voice capture (`mic-recording` + `mic-timer` + `mic-stop`).

## Driving it in the browser

Preconditions:

- Shared dev server on 3000, Worker reachable (Doctor exit `0`), keyed provider, fast pass `sh helpers/verify-ui.sh http://localhost:3000 artifacts/{RUN_ID}/web-composer-new web-composer-new` exits `0`.
- Console-error capture attached before navigation; the console record is mandatory evidence.

- **Model.** Click `composer-model-button`; click `composer-model-option-grok-4`. The button shows the picked model; sending passes it as the `onSubmit` second arg (assert via network payload). Store `01-model.png`.
- **Slash.** Type `/` in `composer-input`: `composer-slash-menu` appears; click `slash-option-plan`: the field holds the plan command. Clear, type `/`, click `slash-option-mention`: the field holds `@`. Store `02-slash.png`.
- **Mention.** Type `@` in the field: `composer-mention-menu` appears; click `mention-option-chief`: the field holds `@chief`. Store `03-mention.png`.
- **Reply.** Set a `replyTo` (click a message's reply affordance): `composer-reply-preview` quotes it; click `reply-dismiss`: the strip disappears. Store `04-reply.png`.
- **Pending.** With a staged pending question, `composer-question-banner` shows `question-option-0/1`; click one: the banner resolves. Store `05-pending.png`. Skip with unmet precondition when no question is staged — report it, do not force one.
- **Chips + banners.** Stage a file: the `composer-attachment` chip shows icon+name+size; `attachment-remove-{id}` removes it. Trigger a banner: `banner-{id}` appears in `composer-banners`; `banner-dismiss-{id}` clears it. Store `06-chips.png` and `07-banner.png`.
- **Meter + badges.** Type past-cap text: `composer-char-count` warns. `composer-context-meter-bar` width grows with length. Stash an entry and stage a file: `composer-stash-badge` and `composer-tasks-badge` counts increment with pulse. Store `08-meter.png`.
- **Compression.** Stage an oversized image and send: no testid — assert the staged thumbnail bytes shrink before send (network payload smaller than the picked file). Store `09-compression.png`.
- **Voice.** Click `composer-mic`: `mic-recording` appears with `mic-timer` counting and `mic-stop` ending it. Where `getUserMedia` is missing, `mic-unavailable` shows instead — report the environment, not a failure. Store `10-voice.png`.
- **Proof.** Store screenshots, the console record, and the transcript in `artifacts/{RUN_ID}/web-composer-new/`. This feature is driven once per change — do not re-drive it from another pass.

## Gotchas

- Track testids override the brief: `composer-model-button`/`composer-model-menu`/`composer-model-option-*`, `slash-option-*`, `composer-mention-menu`/`mention-option-*`, `composer-reply-preview`, `composer-question-banner`/`question-option-*`, `composer-char-count`, `composer-context-meter(-bar)`, `composer-tasks-badge`/`composer-stash-badge`, `mic-timer`/`mic-unavailable`. Accept the bare brief aliases when both render.
- Slash menu opens only on a leading `/` (first character); `@` menu options come from the `bots` prop — an empty roster means an empty menu, not a bug.
- Model choice is per-draft: reloading or switching drafts resets it; assert the `onSubmit` second arg, not a global setting.
- Compression has no testid by design — never assert on a missing element; compare staged bytes vs payload bytes.
- Voice needs mic permission: headless runs show `mic-unavailable`; that is the designed fallback.
