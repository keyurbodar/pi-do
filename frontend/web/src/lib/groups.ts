// Groups client: crew chat over the shared inbox. The routes forward
// c.req to the workspace DO without validators (same as the forwarded
// session routes in session.ts), so plain fetch carries the payloads.
import { workerBaseUrl } from "./hc-client";

/** One row of GET/POST /workspaces/:id/groups — the roster's server truth. */
export interface GroupSummary {
  id: string;
  name: string;
  thread: string;
  members: string[];
}

/** One row of GET /workspaces/:id/groups/messages — a fanned-out inbox row. */
export interface GroupMessage {
  id: string;
  thread: string | null;
  from: string;
  to: string;
  body: string;
  requestId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  outcomeCursor: number | null;
}

function failed(status: number, what: string): Error {
  return new Error(
    `${what} failed with status ${status}: start the Worker (npm run dev in worker/) and reload.`,
  );
}

function malformed(what: string): Error {
  return new Error(
    `${what} returned a malformed response: restart the Worker dev server and reload.`,
  );
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw malformed(what);
  return value as Record<string, unknown>;
}

function asGroup(value: unknown, what: string): GroupSummary {
  const rec = asRecord(value, what);
  const id = rec["id"];
  const name = rec["name"];
  const thread = rec["thread"];
  const members = rec["members"];
  if (typeof id !== "string" || id.length === 0) throw malformed(what);
  if (typeof name !== "string" || name.length === 0) throw malformed(what);
  return {
    id,
    name,
    thread: typeof thread === "string" ? thread : "",
    members: Array.isArray(members)
      ? members.filter((member): member is string => typeof member === "string")
      : [],
  };
}

function asMessage(value: unknown, what: string): GroupMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  const id = rec["id"];
  const from = rec["from"];
  const to = rec["to"];
  const body = rec["body"];
  if (typeof id !== "string" || typeof from !== "string" || typeof to !== "string" || typeof body !== "string") {
    return null;
  }
  return {
    id,
    thread: typeof rec["thread"] === "string" ? rec["thread"] : null,
    from,
    to,
    body,
    requestId: typeof rec["requestId"] === "string" ? rec["requestId"] : null,
    createdAt: typeof rec["createdAt"] === "string" ? rec["createdAt"] : "",
    deliveredAt: typeof rec["deliveredAt"] === "string" ? rec["deliveredAt"] : null,
    outcomeCursor: typeof rec["outcomeCursor"] === "number" ? rec["outcomeCursor"] : null,
  };
}

export async function createGroup(
  ws: string,
  input: { name: string; members: string[] },
): Promise<GroupSummary> {
  const what = "POST /workspaces/:id/groups";
  const res = await fetch(`${workerBaseUrl()}/workspaces/${ws}/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, members: input.members }),
  });
  if (!res.ok) throw failed(res.status, what);
  return asGroup(asRecord(await res.json(), what)["group"], what);
}

export async function listGroups(ws: string): Promise<GroupSummary[]> {
  const what = "GET /workspaces/:id/groups";
  const res = await fetch(`${workerBaseUrl()}/workspaces/${ws}/groups`);
  if (!res.ok) throw failed(res.status, what);
  const body = asRecord(await res.json(), what);
  const rows = body["groups"];
  if (!Array.isArray(rows)) throw malformed(what);
  return rows.map((row) => asGroup(row, what));
}

export async function deleteGroup(ws: string, gid: string): Promise<void> {
  const what = "DELETE /workspaces/:id/groups";
  const res = await fetch(`${workerBaseUrl()}/workspaces/${ws}/groups?id=${encodeURIComponent(gid)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw failed(res.status, what);
}

export async function groupMessages(ws: string, gid: string): Promise<GroupMessage[]> {
  const what = "GET /workspaces/:id/groups/messages";
  const res = await fetch(
    `${workerBaseUrl()}/workspaces/${ws}/groups/messages?id=${encodeURIComponent(gid)}`,
  );
  if (!res.ok) throw failed(res.status, what);
  const body = asRecord(await res.json(), what);
  const rows = body["messages"];
  if (!Array.isArray(rows)) throw malformed(what);
  const out: GroupMessage[] = [];
  for (const row of rows) {
    const message = asMessage(row, what);
    if (message !== null) out.push(message);
  }
  return out;
}

export async function sendGroupMessage(
  ws: string,
  gid: string,
  input: { from: "user" | string; body: string; requestId?: string },
): Promise<{ delivered: number; thread: string }> {
  const what = "POST /workspaces/:id/groups/messages";
  const res = await fetch(
    `${workerBaseUrl()}/workspaces/${ws}/groups/messages?id=${encodeURIComponent(gid)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw failed(res.status, what);
  const body = asRecord(await res.json(), what);
  return {
    delivered: typeof body["delivered"] === "number" ? body["delivered"] : 0,
    thread: typeof body["thread"] === "string" ? body["thread"] : "",
  };
}
