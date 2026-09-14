import { api, workerBaseUrl } from "./hc-client";

export interface SessionHandle {
  workspaceId: string;
  sessionId: string;
}

/** One row of GET /workspaces/:id/sessions — the roster's server truth. */
export interface SessionSummary {
  sid: string;
  name: string | null;
  backstory: string | null;
  created: string | null;
  openRun: boolean;
  head: number;
  count: number;
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

// The workspace id is the roster's anchor: sessions live under it, so it
// persists in localStorage and is validated on boot. A stale id (fresh
// worker storage) remints once; a dead worker just propagates the failure.
const WORKSPACE_KEY = "pi-do.workspace.v1";

function storedWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function storeWorkspaceId(id: string): void {
  try {
    window.localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    // Storage full or unavailable: the in-memory id still serves this load.
  }
}

async function mintWorkspace(): Promise<string> {
  const wsRes = await api.workspaces.$post();
  if (!wsRes.ok) throw failed(wsRes.status, "POST /workspaces");
  return asString(asRecord(await wsRes.json(), "POST /workspaces"), "workspaceId", "POST /workspaces");
}

/** null on 404 (unknown workspace → caller remints); other failures throw. */
async function fetchSessionRows(workspaceId: string): Promise<SessionSummary[] | null> {
  const res = await fetch(`${workerBaseUrl()}/workspaces/${workspaceId}/sessions`);
  if (res.status === 404) return null;
  if (!res.ok) throw failed(res.status, "GET /workspaces/:id/sessions");
  const body = asRecord(await res.json(), "GET /workspaces/:id/sessions");
  const rows = body["sessions"];
  if (!Array.isArray(rows)) throw malformed("GET /workspaces/:id/sessions");
  const out: SessionSummary[] = [];
  for (const row of rows) {
    const rec = asRecord(row, "GET /workspaces/:id/sessions");
    const sid = rec["sid"];
    if (typeof sid !== "string" || sid.length === 0) continue;
    out.push({
      sid,
      name: typeof rec["name"] === "string" && rec["name"].length > 0 ? rec["name"] : null,
      backstory: typeof rec["backstory"] === "string" && rec["backstory"].length > 0 ? rec["backstory"] : null,
      created: typeof rec["created"] === "string" ? rec["created"] : null,
      openRun: rec["openRun"] === true,
      head: typeof rec["head"] === "number" ? rec["head"] : 0,
      count: typeof rec["count"] === "number" ? rec["count"] : 0,
    });
  }
  return out;
}

interface WorkspaceBoot {
  workspaceId: string;
  sessions: SessionSummary[];
}

let bootPromise: Promise<WorkspaceBoot> | null = null;
const botSessions = new Map<string, Promise<SessionHandle>>();

function bootWorkspace(): Promise<WorkspaceBoot> {
  if (bootPromise === null) {
    const pending = (async () => {
      const stored = storedWorkspaceId();
      if (stored !== null) {
        const sessions = await fetchSessionRows(stored);
        if (sessions !== null) return { workspaceId: stored, sessions };
      }
      const workspaceId = await mintWorkspace();
      storeWorkspaceId(workspaceId);
      return { workspaceId, sessions: [] };
    })();
    // A failed boot clears the cache so the next call retries instead of
    // serving the same rejection forever.
    bootPromise = pending.catch((e: unknown) => {
      if (bootPromise === pending) bootPromise = null;
      throw e;
    });
  }
  return bootPromise;
}

export function ensureWorkspace(): Promise<string> {
  return bootWorkspace().then((boot) => boot.workspaceId);
}

/** Roster hydration: every session in the workspace, server-authoritative. */
export function listSessions(): Promise<SessionSummary[]> {
  return bootWorkspace().then((boot) => boot.sessions);
}

/** Mint a roster-backed session: name and combined backstory persist on the
 * sessions row, so the bot survives reloads and hydrates from GET /sessions.
 * A fresh session already carries the workspace default model. */
export async function createBotSession(name: string, backstory: string | null): Promise<SessionHandle> {
  const workspaceId = await ensureWorkspace();
  const what = "POST /workspaces/:id/sessions";
  const session = await postForwarded(`/workspaces/${workspaceId}/sessions`, what, {
    name,
    ...(backstory !== null ? { backstory } : {}),
  });
  return { workspaceId, sessionId: asString(session, "sessionId", what) };
}

/** Tombstone a session server-side; 404 means it is already gone. */
export async function deleteSession(ws: string, sid: string): Promise<void> {
  const what = "DELETE /workspaces/:id/sessions/:sid";
  const res = await fetch(
    `${workerBaseUrl()}/workspaces/${ws}/sessions/${encodeURIComponent(sid)}`,
    { method: "DELETE" },
  );
  if (res.status === 404) return;
  if (!res.ok) throw failed(res.status, what);
}

/** One session per roster bot, resolved lazily on first open and cached for
 * the page lifetime, so each bot's conversation is its own. The stream
 * sends bare prompts, so no claim or model call is needed here. Group
 * owners (local "group-" ids) get null — the crew-chat unit fills that seam. */
export function sessionForOwner(ownerId: string): Promise<SessionHandle | null> {
  if (ownerId.startsWith("group-")) return Promise.resolve(null);
  let pending = botSessions.get(ownerId);
  if (pending === undefined) {
    const created = ensureWorkspace().then((workspaceId) => ({
      workspaceId,
      sessionId: ownerId,
    }));
    // A rejected handle (e.g. transient boot failure) evicts itself so the
    // next open retries instead of serving the same rejection forever.
    pending = created.catch((e: unknown) => {
      if (botSessions.get(ownerId) === pending) botSessions.delete(ownerId);
      throw e;
    });
    botSessions.set(ownerId, pending);
  }
  return pending;
}

/** Drop a cached handle (deleteBot removes the row and tombstones the session). */
export function evictSession(ownerId: string): void {
  botSessions.delete(ownerId);
}
