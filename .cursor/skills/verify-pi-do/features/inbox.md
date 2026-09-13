# Inbox (peer messaging)

Activates the Inbox feature (PR55: bot inbox). A session sends a durable
message to another session by id or name; the row persists before any wake
("there is no channel, only a table"). The recipient wakes through the alarm
into a normal turn whose prompt is an `<inbox-changed/>` sentinel plus the
message bodies; rows are marked delivered in the same transaction that
persists the consuming turn's prompt entry, so a crash mid-turn re-delivers
(at-least-once) instead of losing. An unknown recipient materializes a new
named session on first message. Rows sharing a `thread` key are a channel.

## Sub-features

- `inbox-send` sends a durable message to a session id or name and returns the row.
- `inbox-list` lists messages to or from the session; `?thread=T` lists a channel (both directions).
- `wake-idle` an idle recipient wakes through the alarm; the consuming prompt entry carries `inboxIds` plus the bodies; `deliveredAt` and `outcomeCursor` are set after the turn.
- `request-dedupe` the same `requestId` from the same sender returns the original row, never a second one.
- `restart-resilience` a server death between send and wake still delivers exactly once.
- `spawn-by-message` an unknown recipient materializes a named session on first message.
- `ack-wait` send with `wait:true` long-polls until the consuming turn completes (result cursor in `outcomeCursor`) or times out (202 with `ack:"timeout"`; cap 120s, default 30s).

## How to get to it (user POV)

- `POST {BASE}/workspaces/{id}/sessions/{sid}/inbox` with `{"to": "<session id or name>", "body": "text", "thread": "optional", "requestId": "optional", "wait": true, "timeout": 30}`.
- `GET {BASE}/workspaces/{id}/sessions/{sid}/inbox` — messages to/from the session; `?thread=T` for a channel.
- `cli inbox send --ws WS --sid SID --to SESSION --body T [--thread T] [--request-id R] [--wait] [--timeout S] --json`
- `cli inbox list --ws WS --sid SID [--thread T] --json`

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS and two sessions S1 (sender) and S2 (recipient) exist
  (sessions-entries recipe). The stub model is fine: a wake turn runs a real
  turn (read + bash on seed.txt — seed `seed.txt` or the stub's fixed script
  errors), keyless.

- **Send persists before wake.** Run
  `cli inbox send --ws {WS} --sid {S1} --to {S2} --body "wake-msg-{RUN_ID}" --request-id "p1" --json`.
  HTTP 201 with `.message.id` (store as MID). Immediately
  `cli inbox list --ws {WS} --sid {S2} --json` — the row is readable; body
  matches. (The wake may deliver before you look — persistence is the
  property being proven, delivery speed is a bonus.)
- **Wake + ack.** Send again with `--wait --timeout 60`. The response is
  200 with `deliveredAt` set and a non-null `outcomeCursor` (the cursor of
  the recipient's consuming `result` entry). Re-read the recipient's entries
  (`cli entries --ws --sid {S2} --all --json`): exactly one prompt entry
  whose body parses with `inboxIds` containing MID and whose `prompt`
  includes `<inbox-changed` and the message body, followed by a `result`
  entry at `outcomeCursor`.
- **Dedupe.** Repeat the same send with the same `--request-id`. The
  returned `.message.id` equals the first; list shows one row for that id.
- **Restart mid-wait.** Record the dev-server PID
  (`artifacts/{RUN_ID}/server.pid`), send a message to a fresh session,
  kill the recorded PID, relaunch on the SAME port, rewrite the pidfile,
  and poll the recipient's entries. Exactly one consuming turn appears —
  the row was durable before the wake, so zero fires is a lost message and
  two fires is a broken delivered-marking; both fail the run.
- **Ordering.** Send two messages (distinct request ids) to one recipient,
  wait for both, and assert both bodies appear in prompt entries with the
  first send's body not after the second's.
- **Channel.** Send A→B and B→A with `--thread offsite-{RUN_ID}`, then
  `curl "{BASE}/workspaces/{WS}/sessions/{S1}/inbox?thread=offsite-{RUN_ID}"`
  — both rows list.
- **Spawn-by-message.** Send to `--to fresh-bot-{RUN_ID}` (no such session).
  The response's `.message.to` is a new session id; `meta` on it shows
  `name: fresh-bot-{RUN_ID}`, and the message delivers there.
- **Proof.** Store send/list bodies, the entries re-reads, and the restart
  transcript (old PID, kill, relaunch, new PID) in
  `artifacts/{RUN_ID}/inbox/`. The canonical 7-scenario run is
  `sh verify/inbox-proof.sh` (self-boots on :8795).

## Gotchas

- ONE dev server per port, always. workerd binds 8787 with port reuse, so a
  second `wrangler dev` on the same port splits requests between two
  instances with different code and state: writes vanish, reads miss, and
  every check fails confusingly. `lsof -iTCP:PORT -sTCP:LISTEN` must show
  exactly one workerd before driving; proofs that self-boot
  (inbox-proof.sh, routines-proof.sh) need their port otherwise free.
- A stray funded key (env `OPENCODE_API_KEY` or a copied `worker/.dev.vars`)
  flips runs to the keyed path; the stub-marker assertions then fail
  because the real model answered instead of the stub script.
- The consuming prompt entry's `body` is a JSON string, not an object —
  parse before reading `inboxIds`/`prompt` (the helpers in the proof do).
- A busy recipient delays its wake (the wake turn queues behind the live
  turn); check `deliveredAt` before declaring a message lost. The sentinel
  is a count plus bodies in one turn — multiple messages to one recipient
  arrive grouped, in send order.
- Failed wake turns land an `error` entry and leave rows undelivered for
  re-delivery after the 120s claim window; an error entry plus a later
  delivery is the retry design, not a duplicate bug.
- Self-send (`to == sid`) is rejected with a hint; the spawned-session
  flow is the only way a "new" participant appears.
