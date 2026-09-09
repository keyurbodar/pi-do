import { api, workerBaseUrl } from "./hc-client";

export interface SessionHandle {
  workspaceId: string;
  sessionId: string;
  fence: string;
  revision: number;
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

function asString(record: Record<string, unknown>, name: string, what: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) throw malformed(what);
  return value;
}

function asNumber(record: Record<string, unknown>, name: string, what: string): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isInteger(value)) throw malformed(what);
  return value;
}
/** POST a JSON body to a worker route that forwards c.req to the DO without
 * validators — hc types no json there, so plain fetch carries the payload. */
async function postForwarded(path: string, what: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${workerBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw failed(res.status, what);
  return asRecord(await res.json(), what);
}

export async function fetchKeyedProviders(): Promise<string[]> {
  const res = await api.models.$get();
  if (!res.ok) throw failed(res.status, "GET /models");
  // GET /models returns a bare Response.json, so hc types the body unknown;
  // narrow to the keyed list the worker serves.
  const body = (await res.json()) as { keyed?: unknown };
  if (!Array.isArray(body.keyed)) return [];
  return body.keyed.filter((provider): provider is string => typeof provider === "string");
}

export async function bootstrapSession(): Promise<SessionHandle> {
  const wsRes = await api.workspaces.$post();
  if (!wsRes.ok) throw failed(wsRes.status, "POST /workspaces");
  const workspaceId = asString(
    asRecord(await wsRes.json(), "POST /workspaces"),
    "workspaceId",
    "POST /workspaces",
  );

  const seRes = await api.workspaces[":id"].sessions.$post({ param: { id: workspaceId } });
  if (!seRes.ok) throw failed(seRes.status, "POST /workspaces/:id/sessions");
  const session = asRecord(await seRes.json(), "POST /workspaces/:id/sessions");
  const sessionId = asString(session, "sessionId", "POST /workspaces/:id/sessions");
  const fence = asString(session, "fence", "POST /workspaces/:id/sessions");
  const revision = asNumber(session, "revision", "POST /workspaces/:id/sessions");

  const claimed = await postForwarded(
    `/workspaces/${workspaceId}/sessions/${sessionId}/claim`,
    "POST /workspaces/:id/sessions/:sid/claim",
    { fence, expected: revision },
  );
  const fence2 = asString(claimed, "fence", "POST /workspaces/:id/sessions/:sid/claim");
  const revision2 = asNumber(claimed, "revision", "POST /workspaces/:id/sessions/:sid/claim");

  // No explicit model choice: resolve the keyed default server-side so fresh
  // sessions run keyed without duplicating precedence in the client.
  const modeled = await postForwarded(
    `/workspaces/${workspaceId}/sessions/${sessionId}/model`,
    "POST /workspaces/:id/sessions/:sid/model",
    { fence: fence2, expected: revision2 },
  );
  return {
    workspaceId,
    sessionId,
    fence: asString(modeled, "fence", "POST /workspaces/:id/sessions/:sid/model").length > 0
      ? asString(modeled, "fence", "POST /workspaces/:id/sessions/:sid/model")
      : fence2,
    revision: typeof modeled["revision"] === "number" && Number.isInteger(modeled["revision"])
      ? (modeled["revision"] as number)
      : revision2,
  };
}
