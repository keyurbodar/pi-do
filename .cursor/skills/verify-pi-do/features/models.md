# Models and thinking

Activates PR24 (catalog) / PR25 (provider slices) / PR26 (switching). A
user picks a model and thinking level per session, overrides them for one
turn, and sets workspace defaults that new sessions inherit.

## Sub-features

- `models-catalog` lists provider model ids with context windows.
- `model-switch` changes a session's model; the change is a persisted entry and `/run` reports the new model.
- `thinking-switch` changes a session's thinking level, clamped to what the model supports.
- `switch-fail-closed` rejects unknown ids, unsupported levels, and stale fences with no mutation.
- `oneshot-override` runs one turn on another model/level; the session row is unchanged.
- `workspace-defaults` sets the triple new sessions inherit at mint.

## How to get to it (user POV)

- `cli models --provider anthropic` for the catalog slice.
- `cli model --ws WS --sid SID --model provider/id` to switch (fence-attached when fenced).
- `cli thinking --ws WS --sid SID --level high` to switch level.
- `cli run --ws WS --sid SID --prompt ... --model provider/id --thinking high` for one turn elsewhere.
- `cli settings --ws WS --model provider/id --level low` for defaults; bare `cli settings --ws WS` reads them back.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS and session SID exist.

- **Catalog.** List one provider. Run
  `cli models --provider anthropic --base {BASE} --json`.
  The ids carry numeric `contextWindow` values.
- **Switch.** Switch model mid-session. Run
  `cli model --ws {WS} --sid {SID} --model anthropic/claude-opus-4-6 --base {BASE} --json`.
  A `model_change` entry is appended; the next `run` reports the new model in `runtime`.
- **Thinking.** Switch level past the top. Run
  `cli thinking --ws {WS} --sid {SID} --level xhigh --base {BASE} --json`.
  The entry records the requested level and the applied level is clamped.
- **Fail closed.** Switch to an unknown id, an unsupported level, and with a
  stale fence. All three commands exit nonzero and the session row plus the
  entries replay are unchanged.
- **One-shot.** Run one turn elsewhere. Run
  `cli run --ws {WS} --sid {SID} --prompt "read seed.txt" --model anthropic/claude-sonnet-4-5 --thinking high --base {BASE} --json`.
  The turn's `runtime` shows the override; the session row keeps its own triple.
- **Defaults.** Set workspace defaults, mint a second session, and read back.
  The new session's create body carries the default triple.
- **Proof.** Store the catalog, switch, thinking, one-shot, and settings
  bodies plus `transcript.txt` in `artifacts/{RUN_ID}/models/`.

## Gotchas

- Keyless runs use the stub, which records the model without calling it; a stub proof covers switching, never provider quality.
- Switches are fence-guarded like turns; a stale fence is 403 with no entry appended.
- `meta` reports the current triple; the change entries live in the replay.
