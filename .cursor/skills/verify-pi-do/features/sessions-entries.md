# Sessions and entries

Activates PR07 (persist-on-update) / PR09 (entries replay), extended by
PR11 (one prompt per session at a time) and PR26 (model/thinking columns).
A user opens an agent session, and every model/tool event is persisted so a
later client can replay the full session from a cursor.

## Sub-features

- `session-create` returns `sessionId` plus `fence`, `revision: 0`, and the inherited `model`/`thinking` defaults.
- `entries-replay` pages the session tree with `?after=n&limit=l` and returns the `{entries, head, count}` envelope.
- `session-meta` reads the resume cursor (`head`, `count`, `openRun`, `model`, `thinking`) without replaying entries.
- `resume-late` joins an existing session and sees all prior entries.

## How to get to it (user POV)

- `POST {BASE}/workspaces/{id}/sessions` with an empty body.
- `GET {BASE}/workspaces/{id}/sessions/{sid}/meta` for the resume cursor.
- `GET {BASE}/workspaces/{id}/sessions/{sid}/entries?after=n&limit=l` for pagination.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS from the workspaces-files recipe exists.

- **Create session.** Create one. Run
  `curl -s -X POST {BASE}/workspaces/{WS}/sessions`.
  The response is HTTP 200 with a `sessionId`, a `fence` at `revision: 0`,
  and the inherited `model`/`thinking` defaults; store the id as SID.
- **Replay from zero.** Page the tree. Run
  `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/entries?after=0&limit=100"`.
  The response is `{entries, head, count}` with entries in cursor order, no
  gaps or duplicates. `limit` defaults to 100 and clamps at 1000.
- **Late join.** Simulate resume by re-issuing the same `entries?after=0`
  request as a second client. The second view is identical to the first;
  a metadata-only read does not count as replay proof.
- **Proof.** Store the create body, both reads, plus `transcript.txt` in
  `artifacts/{RUN_ID}/sessions-entries/`.

## Gotchas

- Cursor order is the contract; creation order observed on the socket is not.
- After PR10, every WS `entry` frame must also appear in the replay — check one.
- Open operations interrupted by a restart must read back as interrupted, never as silently complete.
- Concurrent prompts on one session serialize in arrival order (PR11); there is no busy reject, the second turn waits.
- Full model/thinking switching lives in the models recipe; `meta` only reports the current triple.
