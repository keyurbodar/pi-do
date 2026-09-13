// table.ts — the single route table both the edge forwarder (index.ts) and
// the inner dispatcher (workspace-base.ts, via the per-file owned maps below)
// read. Every route shape (methods plus outer path plus inner path plus param
// mapping) is declared exactly once in ROUTE; route files bind their handlers
// to these defs with registerHandler and re-export their slice with
// ownedRoutes. This module imports no runtime code, so plain node can import
// it to prove the table resolves every route.
import type { RouteHandler } from "./_shared";

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface ForwardDef {
  readonly methods: readonly Method[];
  readonly outer: string | null;
  readonly inner: string;
  readonly sid: boolean;
  readonly query: readonly string[];
  readonly passthrough: boolean;
  readonly stream: boolean;
}

function def<const M extends Method, const O extends string | null, const I extends string>(
  methods: readonly M[],
  outer: O,
  inner: I,
  opts?: { sid?: boolean; query?: readonly string[]; passthrough?: boolean; stream?: boolean },
): { methods: readonly M[]; outer: O; inner: I; sid: boolean; query: readonly string[]; passthrough: boolean; stream: boolean } {
  return {
    methods,
    outer,
    inner,
    sid: opts?.sid ?? false,
    query: opts?.query ?? [],
    passthrough: opts?.passthrough ?? false,
    stream: opts?.stream ?? false,
  };
}

// Every route shape once, in the same order index.ts registers them. The
// three outer:null entries are inner-only (no edge route forwards to them).
export const ROUTE = {
  sessions: def(["POST"], "/workspaces/:id/sessions", "/sessions"),
  git: def(["POST"], "/workspaces/:id/sessions/:sid/git", "/git", { sid: true }),
  claim: def(["POST"], "/workspaces/:id/sessions/:sid/claim", "/claim", { sid: true }),
  model: def(["POST"], "/workspaces/:id/sessions/:sid/model", "/model", { sid: true }),
  thinking: def(["POST"], "/workspaces/:id/sessions/:sid/thinking", "/thinking", { sid: true }),
  settings: def(["PUT", "GET"], "/workspaces/:id/settings", "/settings"),
  run: def(["POST"], "/workspaces/:id/sessions/:sid/run", "/run", { sid: true }),
  compact: def(["POST"], "/workspaces/:id/sessions/:sid/compact", "/compact", { sid: true }),
  archive: def(["GET"], "/workspaces/:id/sessions/:sid/archive", "/archive", { sid: true, query: ["page"] }),
  entries: def(["GET"], "/workspaces/:id/sessions/:sid/entries", "/entries", { sid: true, query: ["after", "limit"] }),
  meta: def(["GET"], "/workspaces/:id/sessions/:sid/meta", "/meta", { sid: true, query: ["context"] }),
  snapshot: def(["GET"], "/workspaces/:id/sessions/:sid/snapshot", "/snapshot", { sid: true, query: ["since"] }),
  doctor: def(["GET"], "/workspaces/:id/doctor", "/doctor"),
  fork: def(["POST"], "/workspaces/:id/sessions/:sid/fork", "/fork", { sid: true }),
  clone: def(["POST"], "/workspaces/:id/sessions/:sid/clone", "/clone", { sid: true }),
  checkpoints: def(["GET", "POST"], "/workspaces/:id/sessions/:sid/checkpoints", "/checkpoints", { sid: true }),
  rewind: def(["POST"], "/workspaces/:id/sessions/:sid/rewind", "/rewind", { sid: true }),
  files: def(["PUT", "GET", "DELETE"], "/workspaces/:id/files", "/files", { passthrough: true }),
  exec: def(["POST"], "/workspaces/:id/exec", "/exec"),
  execKill: def(["POST"], "/workspaces/:id/exec/kill", "/exec/kill"),
  execDispose: def(["POST"], "/workspaces/:id/exec/dispose", "/exec/dispose"),
  bgPost: def(["POST"], "/workspaces/:id/bg", "/bg"),
  bgGet: def(["GET"], "/workspaces/:id/bg", "/bg", { query: ["handle"] }),
  bgKill: def(["POST"], "/workspaces/:id/bg/kill", "/bg/kill"),
  stream: def(["GET"], "/workspaces/:id/sessions/:sid/stream", "/stream", { sid: true, stream: true }),
  routines: def(["POST", "GET", "DELETE"], "/workspaces/:id/sessions/:sid/routines", "/routines", { sid: true, query: ["id"] }),
  inbox: def(["POST", "GET"], "/workspaces/:id/sessions/:sid/inbox", "/inbox", { sid: true, query: ["thread", "all"] }),
  create: def(["POST"], null, "/create"),
  exists: def(["GET"], null, "/exists"),
  modelsInner: def(["GET"], null, "/models"),
};

export const FORWARD_TABLE: ForwardDef[] = [
  ROUTE.sessions, ROUTE.git, ROUTE.claim, ROUTE.model, ROUTE.thinking, ROUTE.settings,
  ROUTE.run, ROUTE.compact, ROUTE.archive, ROUTE.entries, ROUTE.meta, ROUTE.snapshot,
  ROUTE.doctor, ROUTE.fork, ROUTE.clone, ROUTE.checkpoints, ROUTE.rewind, ROUTE.files,
  ROUTE.exec, ROUTE.execKill, ROUTE.execDispose, ROUTE.bgPost, ROUTE.bgGet, ROUTE.bgKill,
  ROUTE.stream, ROUTE.routines, ROUTE.inbox,
];

const handlers = new Map<string, RouteHandler>();
const buckets = new Map<string, Record<string, RouteHandler>>();

export function registerHandler(owner: string, route: Pick<ForwardDef, "inner">, handler: RouteHandler): void {
  handlers.set(route.inner, handler);
  let bucket = buckets.get(owner);
  if (bucket === undefined) {
    bucket = {};
    buckets.set(owner, bucket);
  }
  bucket[route.inner] = handler;
}

export function ownedRoutes(owner: string): Record<string, RouteHandler> {
  const bucket = buckets.get(owner);
  if (bucket === undefined) throw new Error(`no routes registered for owner: ${owner}`);
  return bucket;
}

export function innerRoutes(): Record<string, RouteHandler> {
  return Object.fromEntries(handlers);
}

// Resolve a concrete edge request to its table def. Hono owns runtime
// matching; this is the proof instrument the table test reads.
export function matchRoute(method: string, path: string): ForwardDef | undefined {
  const segs = path.split("/");
  for (const route of FORWARD_TABLE) {
    if (route.outer === null || !route.methods.includes(method as Method)) continue;
    const template = route.outer.split("/");
    if (template.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < template.length; i++) {
      const t = template[i];
      if (t.startsWith(":")) {
        if (segs[i].length === 0) {
          ok = false;
          break;
        }
      } else if (t !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return route;
  }
  return undefined;
}

export function forwardQuery(
  route: ForwardDef,
  input: { sid?: string; get?: (name: string) => string | undefined; extra?: Record<string, string> },
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (route.sid) out.sid = input.sid;
  if (input.get !== undefined) {
    for (const key of route.query) out[key] = input.get(key);
  } else {
    for (const key of route.query) out[key] = undefined;
  }
  if (route.passthrough && input.extra !== undefined) Object.assign(out, input.extra);
  return out;
}
