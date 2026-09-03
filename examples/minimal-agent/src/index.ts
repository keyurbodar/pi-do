// minimal-agent — L1 embed: a foreign Worker running the same harness,
// entries, and fence as the first-party Worker via createPiCf. The host
// brings routing plus its DO binding; the factory owns everything else.
import { createPiCf } from "../../../packages/pi-cf/src/index.ts";

export class MinimalAgent extends createPiCf({ model: { id: "stub" } }) {}

interface Env {
  MINIMAL_AGENT: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname.split("/").filter(Boolean);
    const body = request.method === "POST" || request.method === "PUT" ? await request.arrayBuffer() : undefined;
    const at = (id: string) => env.MINIMAL_AGENT.get(env.MINIMAL_AGENT.idFromName(id));
    const fwd = (id: string, inner: string, init?: RequestInit) => at(id).fetch(`http://do${inner}`, init);
    if (request.method === "GET" && p.length === 0) return Response.json({ ok: true, service: "minimal-agent" });
    if (request.method === "POST" && p.length === 1 && p[0] === "workspaces") {
      const id = crypto.randomUUID();
      return fwd(id, "/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: id }) });
    }
    if (p.length >= 3 && p[0] === "workspaces" && p[2] === "files") {
      const inner = new URL("http://do/files");
      inner.searchParams.set("ws", p[1]);
      for (const [k, v] of url.searchParams) inner.searchParams.set(k, v);
      const target = inner.pathname + inner.search;
      return body === undefined ? fwd(p[1], target, { method: request.method }) : fwd(p[1], target, { method: request.method, body });
    }
    if (p.length === 3 && p[0] === "workspaces" && p[2] === "sessions" && request.method === "POST") {
      return fwd(p[1], `/sessions?ws=${encodeURIComponent(p[1])}`, { method: "POST" });
    }
    if (p.length === 5 && p[0] === "workspaces" && p[2] === "sessions" && ["run", "claim", "entries", "meta"].includes(p[4])) {
      const inner = new URL(`http://do/${p[4]}`);
      inner.searchParams.set("ws", p[1]);
      inner.searchParams.set("sid", p[3]);
      for (const [k, v] of url.searchParams) if (k !== "ws" && k !== "sid") inner.searchParams.set(k, v);
      const target = inner.pathname + inner.search;
      if (request.method === "POST") return fwd(p[1], target, { method: "POST", headers: { "content-type": "application/json" }, body });
      return fwd(p[1], target, { method: "GET" });
    }
    return Response.json({ error: "not found", hint: "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files" }, { status: 404 });
  },
};
