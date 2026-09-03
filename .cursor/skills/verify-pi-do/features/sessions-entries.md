# Sessions and entries

Activates PR07 (persist-on-update) / PR09 (entries replay). A user opens an
agent session, and every model/tool event is persisted so a later client can
replay the full session from a cursor.

## Sub-features

- `session-create` returns a `sessionId` from `POST /workspaces/{id}/sessions`.
- `entries-replay` pages the session tree with `?after=n` and reconstructs state.
- `resume-late` joins an existing session and sees all prior entries.

## How to get to it (user POV)

- `POST {BASE}/workspaces/{id}/sessions` with an empty body.
- `GET {BASE}/workspaces/{id}/sessions/{sid}` for metadata plus recent entries.
- `GET {BASE}/workspaces/{id}/sessions/{sid}/entries?after=n` for pagination.

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- A workspace WS from the workspaces-files recipe exists.

- **Create session.** Create one. Run
  `curl -s -X POST {BASE}/workspaces/{WS}/sessions`.
  The response is HTTP 200 with a `sessionId`; store it as SID.
- **Replay from zero.** Page the tree. Run
  `curl -s "{BASE}/workspaces/{WS}/sessions/{SID}/entries?after=0"`.
  The response lists entries in cursor order with no gaps or duplicates.
- **Late join.** Simulate resume by re-issuing the same `entries?after=0`
  request as a second client. The second view is identical to the first;
  a metadata-only read does not count as replay proof.
- **Proof.** Store both reads plus `transcript.txt` in
  `artifacts/{RUN_ID}/sessions-entries/`.

## Gotchas

- Cursor order is the contract; creation order observed on the socket is not.
- After PR10, every WS `entry` frame must also appear in the replay — check one.
- Open operations interrupted by a restart must read back as interrupted, never as silently complete.
