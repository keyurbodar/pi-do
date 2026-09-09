import * as v from "valibot";
import type { SessionUsage } from "pi-cf/agent/session";
import type { SessionUsageMeta } from "pi-cf/store/entries";
import type { FileStore } from "pi-cf/store/vfs-dofs";
import { hintFor, type ValidatorRoute } from "../schemas";
import type { StreamHost } from "../stream";

export interface ShellWorkerBinding {
  exec(input: {
    command: string;
    cwd?: string;
    env?: unknown;
    sid?: string;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean; killed: boolean }>;
  kill(input: { sid: string }): Promise<{ killed: boolean }>;
  dispose(input: { sid: string }): Promise<{ disposed: true; stdoutBytes: number; stderrBytes: number }>;
  bgStart(input: { command: string; cwd?: string; env?: unknown }): Promise<{ handle: string }>;
  bgRead(input: { handle: string }): Promise<{ done: boolean; stdout?: string; stderr?: string; exit?: number; timedOut?: boolean; killed?: boolean }>;
  bgKill(input: { handle: string }): Promise<{ killed: boolean }>;
}

export interface Env {
  WORKSPACE_DO: DurableObjectNamespace;
  SHELL_WORKER: ShellWorkerBinding;
}

export const MINT_WS_HINT = "create one with POST /workspaces first, then mint a session";
export const UNKNOWN_SESSION_HINT = "mint one with POST /workspaces/:id/sessions first, then retry with that session id";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const FILE_TOO_LARGE_HINT = "retry with a file under 8 MiB, or split it across paths";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function err(error: string, hint: string, status: number): Response {
  return json({ error, hint }, status);
}

const JSON_CT = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

function issueKey(issues: unknown): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const first = issues[0];
  if (first === null || typeof first !== "object" || !("path" in first)) return null;
  const path = first.path;
  if (!Array.isArray(path)) return null;
  for (const segment of path) {
    if (segment !== null && typeof segment === "object" && "key" in segment && typeof segment.key === "string") return segment.key;
  }
  return null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; response: Response };

export async function readValidated<T extends v.GenericSchema | v.GenericSchemaAsync>(request: Request, route: ValidatorRoute, schema: T): Promise<Validated<v.InferOutput<T>>> {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !JSON_CT.test(contentType)) {
    const spec = hintFor[route].default;
    return { ok: false, response: err(spec.error, spec.hint, 400) };
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, response: new Response("Malformed JSON in request body", { status: 400 }) };
  }
  const parsed = await v.safeParseAsync(schema, value);
  if (!parsed.success) {
    const table = hintFor[route];
    const key = issueKey(parsed.issues);
    const spec = (key !== null ? table[key] : undefined) ?? table.default;
    return { ok: false, response: err(spec.error, spec.hint, 400) };
  }
  return { ok: true, value: parsed.output };
}

export type UsageRow = { inTokens: number; outTokens: number; cacheRead: number; costTotal: number; elapsedMs: number; tokensPerSec: number | null };

const zeroUsage: UsageRow = { inTokens: 0, outTokens: 0, cacheRead: 0, costTotal: 0, elapsedMs: 0, tokensPerSec: null };

function tokensPerSec(outTokens: number, elapsedMs: number): number | null {
  return outTokens > 0 && elapsedMs >= 100 ? (outTokens * 1000) / elapsedMs : null;
}

export function fmtUsage(sums: SessionUsage, contextWindow: number | null): SessionUsageMeta {
  const full: SessionUsage = { ...zeroUsage, ...sums };
  const context = full.inTokens + full.outTokens + full.cacheRead;
  const contextPct = typeof contextWindow === "number" && contextWindow > 0 ? (context / contextWindow) * 100 : null;
  const hitDenom = full.inTokens + full.cacheRead;
  return { ...full, tokensPerSec: tokensPerSec(full.outTokens, full.elapsedMs), contextPct, hitPct: hitDenom > 0 ? (full.cacheRead / hitDenom) * 100 : 0 };
}

export function fmtModel(sid: string, provider: string, id: string, rot: { fence: string; revision: number } | null, revision: number): Response {
  if (rot !== null) return json({ sessionId: sid, model: { provider, id }, fence: rot.fence, revision: rot.revision });
  return json({ sessionId: sid, model: { provider, id }, revision });
}

export function fmtThinking(sid: string, applied: string, requested: string, rot: { fence: string; revision: number } | null, revision: number): Response {
  if (rot !== null) return json({ sessionId: sid, thinking: applied, requested, fence: rot.fence, revision: rot.revision });
  return json({ sessionId: sid, thinking: applied, requested, revision });
}

export function fmtSettings(ws: string, settings: { provider: string | null; id: string | null; thinking: string | null }): Response {
  return json({ ws, settings: { modelProvider: settings.provider, modelId: settings.id, thinkingLevel: settings.thinking } });
}

export function saveSettings(sql: { exec(query: string, ...bindings: unknown[]): unknown }, ws: string, provider: unknown, id: unknown, thinking: unknown): void {
  sql.exec("INSERT OR REPLACE INTO workspace_settings(ws, modelProvider, modelId, thinkingLevel) VALUES (?, ?, ?, ?)", ws, provider, id, thinking);
}

export interface FenceRead {
  fence: string | null;
  revision: number;
}

export interface FenceNext {
  fence: string;
  revision: number;
}

export interface ModelTriple {
  provider: string | null;
  id: string | null;
  thinking: string | null;
  retention: "short" | "long";
}

export interface WorkspaceSettings {
  provider: string | null;
  id: string | null;
  thinking: string | null;
}

export interface RouteCtx {
  state: DurableObjectState;
  env: Env;
  files: FileStore;
  requireSession(ws: string, sid: string | null, missingHint: string, unknownWsHint: string): Response | null;
  workspaceExists(ws: string): boolean;
  sessionExists(ws: string, sid: string): boolean;
  readFence(sid: string): FenceRead | null;
  rotateFence(sid: string, next: FenceNext): void;
  readTriple(sid: string): ModelTriple | null;
  readSettings(ws: string): WorkspaceSettings;
  sessionContextWindow(triple: { provider: string | null; id: string | null } | null): number | null;
  streamHost(ws: string, sid: string): StreamHost;
  enqueueSessionTurn<T>(sid: string, fn: () => Promise<T>): Promise<T>;
}

export type RouteHandler = (ctx: RouteCtx, request: Request, url: URL) => Promise<Response | null> | Response | null;
