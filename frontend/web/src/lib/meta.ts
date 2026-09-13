// Session meta seam: GET /workspaces/:id/sessions/:sid/meta. The route's
// query params aren't hc-typed (same as /entries), so plain fetch carries it.
import { workerBaseUrl } from "./hc-client";
import type { SessionRef } from "../components/thread/types";

export interface SessionMeta {
  contextUsage: {
    usedTokens: number;
    contextWindow: number;
    reserveTokens: number;
    keepTail: number;
  };
  compaction: {
    pending: boolean;
    archivePages: number;
    archiveTotal: number;
  };
  lastSummarySource: "model" | "degraded" | "deterministic" | null;
  openRun: string | null;
}

export async function fetchMeta(session: SessionRef): Promise<SessionMeta> {
  const res = await fetch(
    `${workerBaseUrl()}/workspaces/${session.workspaceId}/sessions/${session.sessionId}/meta`,
  );
  if (!res.ok) throw new Error(`meta ${res.status}`);
  return (await res.json()) as SessionMeta;
}
