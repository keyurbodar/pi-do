# Extensions

Activates PR19 (inline) / PR20 (wire frames) / PR21a-c (VFS loader). A user
installs an extension once and its tools and commands work from any client,
including clients that never touched the server.

## Sub-features

- `ext-tool` calls a sample extension tool through the agent stream.
- `ext-command` lists extension commands via `get_commands` and runs one.
- `ext-ui` renders an `extension_ui_request` in the client and answers it.
- `ext-vfs` (PR21+) loads the same extension from `.pi/extensions/*.ts`.

## How to get to it (user POV)

- Inline: server started with the sample extension registered.
- `get_commands` over the WS stream lists extension commands.
- `extension_ui_request/response` frames carry blocking extension UI.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- Server runs with the sample extension (tool + command + hook).
- A workspace WS and session SID exist.

- **List commands.** Fetch the command list. Run the CLI `commands` action
  (or `get_commands` over the socket). The sample command appears by name.
- **Run tool.** Prompt for the sample tool. Run
  `cli stream --prompt "use the sample-ext tool to write verified-ok" --frames frames.jsonl`.
  A `tool_start/tool_end` pair names the extension tool and its result entry
  re-reads from entries (same second-view rule as agent-stream).
- **Answer UI.** If the sample raises `extension_ui_request`, answer with
  `extension_ui_response` and observe the resumed turn in later frames.
- **Proof.** Store the command list, `frames.jsonl`, entry re-read, and
  `transcript.txt` in `artifacts/{RUN_ID}/extensions/`.

## Gotchas

- Inline and VFS loading are different entry points; verify each separately
  once PR21 lands. Do not report VFS as verified via the inline path.
- `ctx.ui` components and raw `pi.exec` are deferred; their absence is scope,
  not failure.
- Extension files live in workspace VFS (git-versioned); a host-local copy
  proving the same behavior proves nothing about the loader.
