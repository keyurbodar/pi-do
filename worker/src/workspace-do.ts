// workspace-do.ts — thin Durable Object shell: Worker-side forwarding
// helpers (used by index.ts) plus the WorkspaceDO mount over the shared
// WorkspaceBase (workspace-base.ts: fetch table, alarm-mux wiring, SQL and
// retry helpers). A second DO mounts the same behavior by extending the
// base with its own namespace; nothing behavioral lives here.
import { WorkspaceBase } from "./workspace-base";
export interface ForwardEnv {
  WORKSPACE_DO: DurableObjectNamespace;
}
export interface ForwardRequest {
  method: string;
  url: string;
  header(name: string): string | undefined;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function workspaceStub(env: ForwardEnv, workspaceId: string): DurableObjectStub {
  return env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
}

export async function forwardToWorkspace(env: ForwardEnv, workspaceId: string, path: string, req: ForwardRequest, query: Record<string, string | undefined> = {}): Promise<Response> {
  const inner = new URL(path, "http://do");
  inner.searchParams.set("ws", workspaceId);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) inner.searchParams.set(key, value);
  const stub = workspaceStub(env, workspaceId);
  if (req.method !== "POST" && req.method !== "PUT") return stub.fetch(inner.toString(), { method: req.method });
  const body = await req.arrayBuffer();
  const headers: Record<string, string> = {};
  const contentType = req.header("content-type");
  if (contentType !== undefined) headers["content-type"] = contentType;
  return stub.fetch(inner.toString(), { method: req.method, headers, body });
}

export function createWorkspace(env: ForwardEnv): Promise<Response> {
  const workspaceId = crypto.randomUUID();
  return workspaceStub(env, workspaceId).fetch("http://do/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
}

export function forwardStream(env: ForwardEnv, workspaceId: string, sessionId: string, req: { url: string; raw: Request }): Promise<Response> {
  const inner = new URL("http://do/stream");
  inner.searchParams.set("ws", workspaceId);
  inner.searchParams.set("sid", sessionId);
  const raw = new URL(req.url);
  for (const key of ["fence", "expected"]) {
    const value = raw.searchParams.get(key);
    if (value !== null) inner.searchParams.set(key, value);
  }
  return workspaceStub(env, workspaceId).fetch(new Request(inner.toString(), { method: "GET", headers: req.raw.headers }));
}

export class WorkspaceDO extends WorkspaceBase {}
