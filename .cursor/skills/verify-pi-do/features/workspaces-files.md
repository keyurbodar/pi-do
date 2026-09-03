# Workspaces and files

Activates PR01 (workspace create) / PR02 (files read/write), extended by
PR13 (DELETE + directory listing) and PR15 (v1 agent tools: write/edit/list/
remove through the mutation queue, read/list ranges). A user creates a
workspace, seeds files into it, and reads them back byte-identical.

## Sub-features

- `ws-create` returns a fresh `workspaceId` from `POST /workspaces`.
- `files-roundtrip` writes then re-reads a seeded file with identical bytes.
- `files-list` lists a seeded directory via `GET ?list=DIR`, showing paths and sizes.
- `files-delete` removes one file, or a whole tree with `?recursive=true`.

## How to get to it (user POV)
- `POST {BASE}/workspaces` with an empty body.
- `PUT {BASE}/workspaces/{id}/files?path=verify-{RUN_ID}/hello.txt` with content.
- `GET {BASE}/workspaces/{id}/files?path=verify-{RUN_ID}/hello.txt`.
- `GET {BASE}/workspaces/{id}/files?list=verify-{RUN_ID}/` for a directory listing.
- `DELETE {BASE}/workspaces/{id}/files?path=verify-{RUN_ID}/hello.txt` (add `&recursive=true` for a tree).

## Driving it with pi-do CLI

Preconditions:

- Doctor exits `0` at BASE.
- No workspace exists for this RUN_ID yet.

- **Create workspace.** Create one. Run `curl -s -X POST {BASE}/workspaces`.
  The response is HTTP 200 with a `workspaceId`; store it as WS.
- **Seed file.** Write known content. Run
  `curl -s -X PUT "{BASE}/workspaces/{WS}/files?path=verify-{RUN_ID}/hello.txt" --data-binary "hello-pi-do"`.
  The response is HTTP 200.
- **Second-view read.** Re-read the same path. Run
  `curl -s "{BASE}/workspaces/{WS}/files?path=verify-{RUN_ID}/hello.txt"`.
  The body is byte-identical to what was written; a status alone is not proof.
- **List.** List the directory. Run
  `curl -s "{BASE}/workspaces/{WS}/files?list=verify-{RUN_ID}/"`.
  The response is `{entries:[{path,bytes}]}` containing the seeded file.
- **Delete.** Remove the file. Run
  `curl -s -X DELETE "{BASE}/workspaces/{WS}/files?path=verify-{RUN_ID}/hello.txt"`.
  A re-read now returns 404 `no such file`. Deleting a directory without
  `&recursive=true` returns 400 naming the directory; retry with the flag
  for `{removed:[...]}`.
- **Proof.** Store the POST body, the PUT request, the re-read body, the
  listing, and the delete bodies in `artifacts/{RUN_ID}/workspaces-files/`
  with `transcript.txt`.

## Gotchas

- Always scope seed paths under `verify-{RUN_ID}/` so parallel runs never share state.
- A 200 without a `workspaceId` field is a failure, not a pass.
- Compare bytes, not eyeballed output; whitespace differences count.
- The workspace root itself is never deletable; directory deletes need the flag.
