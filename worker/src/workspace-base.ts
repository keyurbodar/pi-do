// workspace-base.ts — shared Durable Object base: fetch table, alarm-mux
// wiring, SQL schema plus fence/session helpers, and the stream-host
// factory. WorkspaceDO (workspace-do.ts) is a thin subclass; a second DO
// mounts the same behavior by extending this base with its own storage
// namespace. No Worker-side forwarding lives here (that stays thin in
// workspace-do.ts alongside index.ts imports).
import { createDofsVfs, type FileStore } from "pi-cf/store/vfs-dofs";
import { ensureEntriesSchema, entryHead } from "pi-cf/store/entries";
import { ensureChunksSchema } from "pi-cf/store/chunks";
import { ensureRunsSchema } from "pi-cf/store/runs";
import { ensureEpisodeSchema } from "pi-cf/store/episode";
import { ensureWorkspaceSchema } from "pi-cf/store/sql-util";
import { ensureCheckpointsSchema } from "pi-cf/store/checkpoints";
import { ensureCompactionSchema, runPendingCompactions } from "./compaction";
import { sessionSummarizer } from "./summarizer";
import { COMPACTION_JOB, COMPACTION_REARM_MS, KEEPALIVE_JOB, KEEPALIVE_MS, cancelJob, earliestDeadline, runDueJobs, scheduleJob } from "./alarm-mux";
import { ROUTINE_JOB, ensureRoutinesSchema, fireDueRoutines, type RoutineRow } from "./routines";
import { INBOX_JOB, INBOX_REARM_MS, deliverDueInbox, inboxPrompt, rearmInbox } from "./inbox";
import { readBackstory } from "./backstory";
import { resolveSendTarget } from "./groups";
import { listMembers } from "pi-cf/store/groups";
import { ensureGroupsSchema } from "pi-cf/store/groups";
import { insertInbox, markDelivered, ensureInboxSchema, type InboxAccess, type InboxRow } from "pi-cf/store/inbox";
import { makeSidLiveCheck, RECOVERY_JOB, scanTurns } from "pi-cf/store/recovery";
import { nextRunAtMin } from "pi-cf/store/runs";
import { listChunksForTurn } from "pi-cf/store/chunks";
import { appendEntry, closeRun, openRun, recordTurnWithOpen } from "pi-cf/store/entries";
import { broadcastEntries, broadcastEntry, readAttachment, redriveTurn, socketMessage, wrapSocket, executeTurn, type LiveTurn, type StreamHost, type TurnSink } from "./stream";
import type { Agent } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, resolveCatalogModel, type RuntimeEnv } from "./model-runtime";
import { err, UNKNOWN_SESSION_HINT, type Env, type FenceNext, type FenceRead, type ModelTriple, type RouteCtx, type RouteHandler, type WorkspaceSettings } from "./routes/_shared";
import { fileRoutes } from "./routes/files";
import { sessionRoutes } from "./routes/sessions";
import { turnRoutes } from "./routes/turns";
import { opRoutes } from "./routes/ops";
import { doctorRoutes } from "./routes/doctor";
import { routineRoutes } from "./routes/routines";
import { inboxRoutes } from "./routes/inbox";
import { groupMessageRoutes, groupRoutes } from "./routes/groups";

const ROUTES: Record<string, RouteHandler> = {
  ...fileRoutes,
  ...sessionRoutes,
  ...turnRoutes,
  ...opRoutes,
  ...doctorRoutes,
  ...routineRoutes,
  ...inboxRoutes,
  ...groupRoutes,
  ...groupMessageRoutes,
};

export class WorkspaceBase implements DurableObject {
  protected state: DurableObjectState;
  protected files: FileStore;
  protected env: Env;
  protected live = new Map<string, LiveTurn>();
  protected sessionQueues = new Map<string, Promise<void>>();

  protected enqueueSessionTurn<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionQueues.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => cur);
    this.sessionQueues.set(sid, tail);
    return prev.catch(() => {}).then(fn).finally(() => {
      release();
      if (this.sessionQueues.get(sid) === tail) this.sessionQueues.delete(sid);
    });
  }

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.files = createDofsVfs(state.storage.sql);
  }

  protected ensureSchema(): void {
    const sql = this.state.storage.sql;
    ensureWorkspaceSchema(sql);
    this.files.ensureSchema();
    ensureEntriesSchema(sql);
    ensureChunksSchema(sql);
    ensureRunsSchema(sql);
    ensureEpisodeSchema(sql);
    ensureCheckpointsSchema(sql);
    ensureCompactionSchema(sql);
    ensureRoutinesSchema(sql);
    ensureInboxSchema(sql);
    ensureGroupsSchema(sql);
    sql.exec("DROP TABLE IF EXISTS pi_owners");
  }

  protected readFence(sid: string): FenceRead | null {
    const rows = [
      ...this.state.storage.sql.exec("SELECT ownerFence, revision FROM sessions WHERE sid = ?", sid),
    ] as Array<{ ownerFence?: unknown; revision?: unknown }>;
    if (rows.length === 0) return null;
    const raw = rows[0] as { ownerFence?: unknown; revision?: unknown };
    const fence = typeof raw.ownerFence === "string" ? raw.ownerFence : null;
    const revision = typeof raw.revision === "number" ? raw.revision : 0;
    return { fence, revision };
  }

  protected rotateFence(sid: string, next: FenceNext): void {
    this.state.storage.sql.exec("UPDATE sessions SET ownerFence = ?, revision = ? WHERE sid = ?", next.fence, next.revision, sid);
  }

  protected casRotateFence(
    sid: string,
    oldFence: string,
    oldRevision: number,
    next: FenceNext,
  ): boolean {
    const cur = this.readFence(sid);
    if (cur === null || cur.fence !== oldFence || cur.revision !== oldRevision) return false;
    this.rotateFence(sid, next);
    return true;
  }

  protected sessionExists(ws: string, sid: string): boolean {
    const rows = [
      ...this.state.storage.sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND ws = ? LIMIT 1", sid, ws),
    ];
    return rows.length > 0;
  }

  protected workspaceExists(ws: string): boolean {
    const rows = [
      ...this.state.storage.sql.exec(
        "SELECT 1 FROM workspaces WHERE id = ? LIMIT 1",
        ws,
      ),
    ];
    return rows.length > 0;
  }

  protected requireSession(ws: string, sid: string | null, missingHint: string, unknownWsHint: string): Response | null {
    if (!ws) {
      return err("missing workspace", missingHint, 400);
    }
    if (!this.workspaceExists(ws)) {
      return err("unknown workspace", unknownWsHint, 404);
    }
    if (sid !== null && (sid.length === 0 || !this.sessionExists(ws, sid))) {
      return err("unknown session", UNKNOWN_SESSION_HINT, 404);
    }
    return null;
  }

  protected readTriple(sid: string): ModelTriple | null {
    const rows = [
      ...this.state.storage.sql.exec("SELECT modelProvider, modelId, thinkingLevel, cacheRetention FROM sessions WHERE sid = ?", sid),
    ] as Array<{ modelProvider?: unknown; modelId?: unknown; thinkingLevel?: unknown; cacheRetention?: unknown }>;
    if (rows.length === 0) return null;
    const raw = rows[0];
    return {
      provider: typeof raw.modelProvider === "string" ? raw.modelProvider : null,
      id: typeof raw.modelId === "string" ? raw.modelId : null,
      thinking: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : null,
      retention: raw.cacheRetention === "long" ? "long" : "short",
    };
  }

  protected sessionContextWindow(triple: { provider: string | null; id: string | null } | null): number | null {
    try {
      if (triple?.provider && triple?.id) {
        const window = resolveCatalogModel(triple.provider, triple.id).contextWindow;
        if (typeof window === "number" && window > 0) return window;
      }
    } catch {
      return null;
    }
    return null;
  }

  protected readSettings(ws: string): WorkspaceSettings {
    const rows = [
      ...this.state.storage.sql.exec("SELECT modelProvider, modelId, thinkingLevel FROM workspace_settings WHERE ws = ?", ws),
    ] as Array<{ modelProvider?: unknown; modelId?: unknown; thinkingLevel?: unknown }>;
    if (rows.length === 0) return { provider: null, id: null, thinking: null };
    const raw = rows[0];
    return {
      provider: typeof raw.modelProvider === "string" ? raw.modelProvider : null,
      id: typeof raw.modelId === "string" ? raw.modelId : null,
      thinking: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : null,
    };
  }

  protected routeCtx(): RouteCtx {
    return {
      state: this.state,
      env: this.env,
      files: this.files,
      requireSession: (ws, sid, missingHint, unknownWsHint) => this.requireSession(ws, sid, missingHint, unknownWsHint),
      workspaceExists: (ws) => this.workspaceExists(ws),
      sessionExists: (ws, sid) => this.sessionExists(ws, sid),
      readFence: (sid) => this.readFence(sid),
      rotateFence: (sid, next) => this.rotateFence(sid, next),
      readTriple: (sid) => this.readTriple(sid),
      readSettings: (ws) => this.readSettings(ws),
      sessionContextWindow: (triple) => this.sessionContextWindow(triple),
      streamHost: (ws, sid) => this.streamHost(ws, sid),
      enqueueSessionTurn: (sid, fn) => this.enqueueSessionTurn(sid, fn),
      mintSession: (ws, name, backstory) => this.mintSession(ws, name, backstory),
    };
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (handler !== undefined) {
      const res = await handler(this.routeCtx(), request, url);
      if (res !== null) return res;
    }
    return err("not found", "use POST /workspaces, /workspaces/:id/sessions, or /workspaces/:id/files", 404);
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    const sql = this.state.storage.sql;
    const now = Date.now();
    await runDueJobs(sql, now, {
      [COMPACTION_JOB]: async () => {
        await runPendingCompactions(
          sql,
          () => {
            scheduleJob(sql, COMPACTION_JOB, Date.now() + COMPACTION_REARM_MS);
          },
          (sid) => {
            // A live turn streams entries while the alarm fires, so its own
            // early deltas can sit below the archive cutoff. Hand its turnId
            // in so the cutover keeps its ledger row and chunks.
            const turnId = this.live.get(sid)?.chunkTurn?.turnId;
            return turnId === undefined ? [] : [turnId];
          },
          (sid) => sessionSummarizer(this.env as unknown as RuntimeEnv, sql, sid),
          (sid, cursor) => {
            let ws = "";
            for (const row of sql.exec("SELECT ws FROM sessions WHERE sid = ? LIMIT 1", sid)) {
              if (typeof row === "object" && row !== null && typeof (row as Record<string, unknown>).ws === "string") ws = (row as Record<string, unknown>).ws as string;
            }
            broadcastEntry(this.streamHost(ws, sid), cursor);
          },
        );
      },
      [KEEPALIVE_JOB]: () => {
        if (this.live.size > 0) scheduleJob(sql, KEEPALIVE_JOB, Date.now() + KEEPALIVE_MS);
      },
      // Routine fire: claimed rows enqueue their prompt through the session's
      // normal turn pipeline (fence-free, like the headless run route); the
      // claim already moved next_run_at, so a re-entrant tick cannot re-fire.
      [ROUTINE_JOB]: async () => {
        await fireDueRoutines(sql, Date.now(), (routine) => this.fireRoutineTurn(routine));
      },
      // Inbox wake: one queued turn per recipient session carrying its
      // undelivered messages. The queue serializes behind a busy turn, and a
      // wake turn whose rows were consumed exits without running the model.
      [INBOX_JOB]: async () => {
        await deliverDueInbox(sql, Date.now(), (ws, sid, rows) => this.fireInboxTurn(ws, sid, rows));
      },
      // Orphan-turn recovery: scan due ledger rows and re-drive them through
      // redriveTurn (same turnId, prompt replayed, committed prefix skipped).
      // Re-arm only while rows remain: earliest future backoff, or the scan's
      // rearm when rows are still due now (scan cap). No rows means silence;
      // the next turn open re-arms the scan by itself.
      [RECOVERY_JOB]: async () => {
        const summary = await scanTurns(sql, Date.now(), {
          isLive: makeSidLiveCheck(this.live),
          redrive: async (input) => {
            let ws = "";
            for (const row of sql.exec("SELECT ws FROM sessions WHERE sid = ? LIMIT 1", input.sid)) {
              if (typeof row === "object" && row !== null && typeof (row as Record<string, unknown>).ws === "string") {
                ws = (row as Record<string, unknown>).ws as string;
              }
              break;
            }
            if (ws === "") throw new Error("redrive needs a live session");
            let skip: number;
            if (input.fresh) {
              // No safe resume point: skip the leading pinned run (chunk and
              // entry land together, so a surviving pin is committed) and
              // regenerate the rest.
              skip = 0;
              for (const c of listChunksForTurn(sql, input.sid, input.turnId)) {
                if (c.cursor === null) break;
                skip += 1;
              }
              // Packed text tail rows can lag their entries across a crash
              // (entries stay per-delta durable; chunk segments flush at
              // boundaries), so a lost tail would undercount the committed
              // prefix. Floor the skip at the entry count after the run's
              // start cursor (minus the never-re-pushed prompt) so the
              // regenerated turn never duplicates committed entries.
              try {
                const committed = entryHead(sql, input.sid).head - input.cursor - 1;
                if (committed > skip) skip = committed;
              } catch {
                // Entry probe failed; the chunk math above stands.
              }
            } else {
              // Prompt occupies chunk seq 0 but is never re-pushed, so the
              // committed delta count is one less than the resume length.
              skip = input.nextSeq - input.suffix.length - 1;
            }
            if (skip < 0) skip = 0;
            await redriveTurn(this.streamHost(ws, input.sid), { ...input, prompt: input.prompt, skipDeltas: skip });
          },
        });
        const nxt = nextRunAtMin(sql);
        if (nxt !== null) scheduleJob(sql, RECOVERY_JOB, nxt <= Date.now() ? summary.rearmAt : Math.min(nxt, summary.rearmAt));
      },
    });
    const next = earliestDeadline(sql);
    if (next === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(next);
  }

  // The fire path mirrors the headless run route: same sink shape, no fence
  // rotation (no client holds one), prompt entry carries routineId so its
  // entries stay attributable, and a failure lands an error entry.
  protected fireRoutineTurn(routine: RoutineRow): Promise<void> {
    return this.enqueueSessionTurn(routine.sid, async () => {
      const sql = this.state.storage.sql;
      const runId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const host = this.streamHost(routine.ws, routine.sid);
      const sink: TurnSink = {
        push() {},
        done: (doneId, turn) => {
          const head = entryHead(sql, routine.sid).head;
          recordTurnWithOpen(sql, routine.sid, doneId, routine.prompt, turn.toolCalls, turn.result, turn.usage, turn.halt ?? null, { routineId: routine.id });
          broadcastEntries(host, head);
        },
        fail: (failId, error) => {
          try {
            const head = entryHead(sql, routine.sid).head;
            openRun(sql, routine.sid, failId);
            closeRun(sql, routine.sid, failId);
            appendEntry(sql, routine.sid, "error", { runId: failId, error, routineId: routine.id });
            broadcastEntries(host, head);
          } catch {
          }
        },
        aborted() {},
      };
      const catalog = host.model === null ? null : resolveCatalogModel(host.model.provider, host.model.id);
      const effThinking = host.thinking === null ? null : clampThinkingLevel(catalog ?? {}, host.thinking);
      await executeTurn(host, { prompt: routine.prompt, catalog, thinking: effThinking, runId, turnId }, sink);
    });
  }

  // The wake-turn path mirrors fireRoutineTurn with one ordering guarantee:
  // the carried rows stay undelivered until the same sync transaction that
  // persists the prompt entry marks them delivered with the result cursor,
  // so a crash mid-turn re-delivers (at-least-once) instead of losing.
  protected fireInboxTurn(ws: string, sid: string, rows: InboxRow[]): Promise<void> {
    const ids = rows.map((r) => r.id);
    const prompt = inboxPrompt(rows);
    return this.enqueueSessionTurn(sid, () => {
      const sql = this.state.storage.sql;
      const runId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const host = this.streamHost(ws, sid);
      const sink: TurnSink = {
        push() {},
        done: (doneId, turn) => {
          const head = entryHead(sql, sid).head;
          recordTurnWithOpen(sql, sid, doneId, prompt, turn.toolCalls, turn.result, turn.usage, turn.halt ?? null, { inboxIds: ids });
          markDelivered(sql, ws, ids, entryHead(sql, sid).head);
          broadcastEntries(host, head);
        },
        fail: (failId, error) => {
          try {
            const head = entryHead(sql, sid).head;
            openRun(sql, sid, failId);
            closeRun(sql, sid, failId);
            appendEntry(sql, sid, "error", { runId: failId, error, inboxIds: ids });
            broadcastEntries(host, head);
          } catch {
          }
        },
        aborted() {},
      };
      const catalog = host.model === null ? null : resolveCatalogModel(host.model.provider, host.model.id);
      const effThinking = host.thinking === null ? null : clampThinkingLevel(catalog ?? {}, host.thinking);
      return executeTurn(host, { prompt, catalog, thinking: effThinking, runId, turnId }, sink);
    });
  }

  // The host half of the send tool: resolve the recipient (id, then name,
  // else materialize with the body as persona), persist deduped, wake the
  // alarm. Returns tool-shaped results; errors carry hints.
  inboxAccess(ws: string, fromSid: string): InboxAccess {
    return {
      send: async (fromSidArg, to, body, thread, requestId) => {
        const from = fromSidArg || fromSid;
        if (to === from) return { ok: false, error: "self-send", hint: "the recipient must be a different session; a session cannot message itself" };
        const sql = this.state.storage.sql;
        ensureInboxSchema(sql);
        const target = resolveSendTarget(sql, ws, (w, s) => this.sessionExists(w, s), to);
        if (target.kind === "group") {
          const members = listMembers(sql, ws, target.group.id).filter((m) => m !== from);
          if (members.length === 0) return { ok: false, error: "empty group", hint: "every member is the sender; add members with POST /workspaces/:id/groups" };
          const ids: string[] = [];
          for (const member of members) {
            const result = insertInbox(sql, ws, from, member, { body, thread: target.group.thread, requestId: requestId === undefined ? undefined : `${requestId}:${member}` });
            if (!result.ok) return result;
            ids.push(result.row.id);
          }
          rearmInbox(sql, Date.now());
          const nextAt = earliestDeadline(sql);
          if (nextAt !== null) await this.state.storage.setAlarm(nextAt);
          return { ok: true, id: ids[0], toSid: target.group.thread, created: false };
        }
        let toSid: string;
        let createdFlag = false;
        if (target.kind === "session") {
          toSid = target.sid;
        } else {
          toSid = this.mintSession(ws, target.name, body.slice(0, 8192));
          createdFlag = true;
        }
        const result = insertInbox(sql, ws, from, toSid, { body, thread, requestId });
        if (!result.ok) return result;
        rearmInbox(sql, Date.now());
        const next = earliestDeadline(sql);
        if (next !== null) await this.state.storage.setAlarm(next);
        return { ok: true, id: result.row.id, toSid, created: createdFlag };
      },
    };
  }

  // Session materialization for spawn-by-message: the same INSERT the
  // sessions route performs, callable from the wake path.
  protected mintSession(ws: string, name: string | null, backstory: string | null = null): string {
    const sql = this.state.storage.sql;
    const defaults = this.readSettings(ws);
    const sessionId = crypto.randomUUID();
    const fence = crypto.randomUUID();
    sql.exec(
      "INSERT INTO sessions(sid, ws, created_at, ownerFence, revision, modelProvider, modelId, thinkingLevel, cacheRetention, name, cwd, backstory) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
      sessionId,
      ws,
      new Date().toISOString(),
      fence,
      defaults.provider,
      defaults.id,
      defaults.thinking,
      "short",
      name,
      null,
      backstory,
    );
    return sessionId;
  }

  protected readBackstory(sid: string): string | null {
    return readBackstory(this.state.storage.sql, sid);
  }

  protected streamHost(ws: string, sid: string): StreamHost {
    const triple = this.readTriple(sid);
    return {
      sql: this.state.storage.sql,
      ws,
      sid,
      files: this.files,
      shell: this.env.SHELL_WORKER,
      runtimeEnv: this.env as unknown as RuntimeEnv,
      thinking: triple?.thinking ?? null,
      retention: triple?.retention ?? "short",
      model: triple?.provider != null && triple?.id != null ? { provider: triple.provider, id: triple.id } : null,
      backstory: this.readBackstory(sid),
      inbox: this.inboxAccess(ws, sid),
      workspaceKnown: ws !== "" && this.workspaceExists(ws),
      sessionKnown: ws !== "" && sid !== "" && this.sessionExists(ws, sid),
      readFence: () => this.readFence(sid),
      casRotateFence: (oldFence, oldRevision, next) => this.casRotateFence(sid, oldFence, oldRevision, next),
      live: this.live,
      sockets: () => this.state.getWebSockets(),
      enqueue: (fn) => this.enqueueSessionTurn(sid, fn),
      scheduleAlarm: async () => {
        scheduleJob(this.state.storage.sql, COMPACTION_JOB, Date.now() + COMPACTION_REARM_MS);
        const next = earliestDeadline(this.state.storage.sql);
        if (next !== null) await this.state.storage.setAlarm(next);
      },
      pokeAlarm: async () => {
        const next = earliestDeadline(this.state.storage.sql);
        if (next === null) await this.state.storage.deleteAlarm();
        else await this.state.storage.setAlarm(next);
      },
      holdKeepalive: async () => {
        scheduleJob(this.state.storage.sql, KEEPALIVE_JOB, Date.now() + KEEPALIVE_MS);
        const next = earliestDeadline(this.state.storage.sql);
        if (next !== null) await this.state.storage.setAlarm(next);
      },
      releaseKeepalive: async () => {
        const next = cancelJob(this.state.storage.sql, KEEPALIVE_JOB);
        if (next === null) await this.state.storage.deleteAlarm();
        else await this.state.storage.setAlarm(next);
      },
    };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = readAttachment(ws);
    if (att === null) {
      const sock = wrapSocket(ws);
      sock.send({ error: "bad handshake", hint: "reconnect the stream; the socket carried no session" });
      sock.close(4403, "socket carried no session");
      return;
    }
    const sock = wrapSocket(ws);
    try {
      await socketMessage(this.streamHost(att.ws, att.sid), sock, message);
    } catch (e) {
      sock.send({
        error: e instanceof Error ? e.message.slice(0, 300) : "unexpected stream failure",
        hint: "retry the frame; if the turn is stuck, send {abort} and reconnect",
      });
    }
  }
}

