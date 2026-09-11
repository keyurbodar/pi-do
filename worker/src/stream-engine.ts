// stream-engine.ts — turn policy over the stream codec: prompt/abort/steer
// frames, executeTurn plus the ledger open/commit wrapper, redrive
// and the recovery driver. Separated from the frame codec
// (stream-codec.ts) so turn policy can evolve without touching transport
// framing. Import through ./stream, which re-exports both halves.
import { bumpSessionTotals, closeRun, entryHead, listEntries, openRun, sessionLeaf, type EntriesSql } from "pi-cf/store/entries";
import { commitPiRun, openPiRun } from "pi-cf/store/runs";
import { clearFallback, clearSteers, enqueueSteer, getFallback, listSteers, markSteerApplied, setFallback, steerOutcome } from "pi-cf/store/episode";
import type { RedriveInput } from "pi-cf/store/recovery";
import { RECOVERY_JOB, RECOVERY_SCAN_MS, scheduleJob } from "./alarm-mux";
import { enforceFence } from "pi-cf/store/fence";
import { createAgentSession, type SessionRunBudgets, type SessionTurn } from "pi-cf/agent/session";
import { clampThinkingLevel, keyedProviders, resolveCatalogModel, resolveKeyedModel, resolveProviderKey, resolveTurnModel, type RuntimeEnv, type RuntimeModel, type TurnModel } from "./model-runtime";
import { compactionPending, maybeMarkForCompaction } from "./compaction";
import { broadcast, CLOSE_CONFLICT, CLOSE_FENCED, CLOSE_UNKNOWN, emitEntry, wrapSocket, type StreamAttachment, type StreamHost, type StreamSocket } from "./stream-codec";
import { isUnknownModel, parseBudgets, shaped } from "./protocol";

export type CheckedFence =
  | { status: number; body: { error: string; hint: string; revision?: number } }
  | { fence: string; revision: number }
  | null;

export type { TurnModel };

export function checkedRotate(
  current: { fence: string | null; revision: number } | null,
  body: unknown,
  missingHint: string,
  write: ((next: { fence: string; revision: number }) => void) | null,
): CheckedFence {
  const rec = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (rec === null || (!("fence" in rec) && !("expected" in rec))) return null;
  const fence = rec["fence"];
  const expected = rec["expected"];
  if (typeof fence !== "string" || fence.length === 0 || !Number.isInteger(expected)) {
    return { status: 400, body: { error: "missing fence", hint: missingHint } };
  }
  const checked = enforceFence(current, fence, expected);
  if ("status" in checked) return { status: checked.status, body: checked.body };
  if (write !== null) write(checked);
  return checked;
}

export { resolveTurnModel };
// Model fallback chain: an unknown-model 404 on the turn's preferred catalog
// entry cycles the other keyed models in catalog order, then the stub, so the
// turn still runs. Anything else (unknown provider, bad MODEL_ID, invalid
// models.json) is a genuine config error and rethrows to keep surfacing.

export interface ModelFallback {
  want: string;
  used: string;
}

function fallbackCatalogs(env: RuntimeEnv, want: string): Array<RuntimeModel | null> {
  const out: Array<RuntimeModel | null> = [];
  for (const provider of keyedProviders(env)) {
    for (const id of [...provider.catalog.keys()].sort()) {
      if (`${provider.id}/${id}` !== want) out.push(provider.catalog.get(id) as RuntimeModel);
    }
  }
  out.push(null);
  return out;
}

// Preferred-model tracking across turns lives in the model_fallback table
// (pi-cf/store/episode), keyed by sid like the steer queues, so the
// fallback position survives an isolate restart mid-episode.

function chainCatalog(env: RuntimeEnv, triple: { provider: string; id: string } | null): { catalog: RuntimeModel | null; want: string | null; fallback: ModelFallback | null } {
  if (triple === null) return { catalog: null, want: null, fallback: null };
  const want = `${triple.provider}/${triple.id}`;
  try {
    return { catalog: resolveCatalogModel(triple.provider, triple.id), want, fallback: null };
  } catch (e) {
    if (!isUnknownModel(e)) throw e;
  }
  const fell = fallbackCatalogs(env, want)[0] ?? null;
  return { catalog: fell, want, fallback: { want, used: fell === null ? "stub" : `${fell.provider}/${fell.id}` } };
}

function openRunId(sql: EntriesSql, sid: string): string | null {
  for (const row of sql.exec("SELECT runId FROM runs WHERE sid = ? AND status = ? LIMIT 1", sid, "open")) {
    if (row !== null && typeof row === "object" && "runId" in row && typeof row.runId === "string") {
      return row.runId;
    }
  }
  return null;
}

export function acceptStream(request: Request, host: StreamHost, state: DurableObjectState): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(
      {
        error: "missing upgrade",
        hint: "retry as GET /workspaces/:id/sessions/:sid/stream with an Upgrade: websocket handshake",
      },
      { status: 400 },
    );
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  state.acceptWebSocket(server);
  server.serializeAttachment({ ws: host.ws, sid: host.sid } satisfies StreamAttachment);
  const sock = wrapSocket(server);

  if (!host.workspaceKnown) {
    const hint = "create one with POST /workspaces first, then mint a session";
    sock.send({ error: "unknown workspace", hint });
    sock.close(CLOSE_UNKNOWN, hint);
    return new Response(null, { status: 101, webSocket: client });
  }
  if (!host.sessionKnown) {
    const hint = "mint one with POST /workspaces/:id/sessions first, then retry with that session id";
    sock.send({ error: "unknown session", hint });
    sock.close(CLOSE_UNKNOWN, hint);
    return new Response(null, { status: 101, webSocket: client });
  }

  try {
    const query = new URL(request.url).searchParams;
    if (query.has("fence") || query.has("expected")) {
      const fenceBody: Record<string, unknown> = {};
      if (query.has("fence")) fenceBody["fence"] = query.get("fence");
      if (query.has("expected")) fenceBody["expected"] = Number(query.get("expected"));
      const rot = checkedRotate(host.readFence(), fenceBody, "retry the stream with both ?fence=F&expected=N from the live session row", null);
      if (rot !== null && "status" in rot) {
        sock.send(rot.body);
        sock.close(rot.status === 409 ? CLOSE_CONFLICT : CLOSE_FENCED, rot.body.hint);
        return new Response(null, { status: 101, webSocket: client });
      }
    }
  } catch {
    const hint = "could not read the stream handshake; reconnect and retry";
    sock.send({ error: "bad handshake", hint });
    sock.close(CLOSE_FENCED, hint);
    return new Response(null, { status: 101, webSocket: client });
  }
  if (host.live.get(host.sid) === undefined) {
    for (let n = 0; n < 32; n++) {
      const orphan = openRunId(host.sql, host.sid);
      if (orphan === null) break;
      host.sql.exec("UPDATE runs SET status = ? WHERE sid = ? AND runId = ?", "interrupted", host.sid, orphan);
      emitEntry(host, sock, "interrupted", { runId: orphan });
    }
  }

  return new Response(null, { status: 101, webSocket: client });
}

// Follow-up steer queue: steers that arrive before the agent attaches wait
// in the steer_queue table (pi-cf/store/episode) in arrival order and drain
// into agent.steer on attach, so every mid-turn steer applies in order
// instead of only reaching a live agent. Keyed by runId; the turn's
// finally deletes its rows, and rows persist before their frames emit, so
// a restart mid-episode keeps the queue. Done/abort acks reconcile applied
// vs still-pending so no steer goes silent.

export async function socketMessage(
  host: StreamHost,
  sock: StreamSocket,
  message: string | ArrayBuffer,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad frame");
    msg = parsed as Record<string, unknown>;
  } catch {
    sock.send({ error: "bad frame", hint: "send JSON like {prompt, fence, expected}, {abort}, or {steer, text}" });
    return;
  }
  const isAbort = msg["abort"] === true || msg["type"] === "abort";
  const steerOn = msg["steer"] === true || msg["type"] === "steer";
  const promptValue = typeof msg["prompt"] === "string"
    ? (msg["prompt"] as string)
    : msg["type"] === "prompt" && typeof msg["text"] === "string"
      ? (msg["text"] as string)
      : undefined;

  if (isAbort) {
    const live = host.live.get(host.sid);
    if (live !== undefined) live.controller.abort();
    else {
      sock.send({ error: "no turn in flight", hint: "send {prompt} first; abort only cancels a running turn" });
    }
    return;
  }
  if (steerOn) {
    const text = msg["text"];
    if (typeof text !== "string" || text.length === 0) {
      sock.send({ error: "missing steer text", hint: "retry as {steer, text} with a non-empty string" });
      return;
    }
    const runId = openRunId(host.sql, host.sid);
    if (runId === null) {
      sock.send({ error: "no turn in flight", hint: "send {prompt} first; steer only appends mid-turn" });
      return;
    }
    const seq = enqueueSteer(host.sql, runId, text);
    emitEntry(host, sock, "steer", { runId, text });
    const live = host.live.get(host.sid);
    if (live?.agent !== undefined) {
      live.agent.steer({ role: "user", content: text, timestamp: Date.now() });
      markSteerApplied(host.sql, runId, seq);
      sock.send({ steered: true, runId, steer: listSteers(host.sql, runId).length });
    } else {
      const outcome = steerOutcome(host.sql, runId);
      sock.send({ steered: false, runId, queued: outcome.pending.length, hint: "no live agent yet; the steer is queued in order, persists with the turn, and applies on attach or on the next turn" });
    }
    return;
  }
  if (promptValue !== undefined) {
    if (promptValue.length === 0) {
      sock.send({ error: "missing prompt", hint: 'retry with a non-empty prompt, e.g. {"prompt": "read seed.txt"}' });
      return;
    }
    const budgets = parseBudgets(msg["budgets"]);
    if (!budgets.ok) {
      sock.send({ error: budgets.error, hint: budgets.hint });
      return;
    }
    const hasFence = "fence" in msg || "expected" in msg;
    await startTurn(host, sock, promptValue, msg["fence"], msg["expected"], hasFence, budgets.budgets);
    return;
  }
  sock.send({ error: "unknown frame", hint: "send {prompt, fence, expected}, {abort}, or {steer, text}" });
}

export interface TurnInput {
  prompt: string;
  catalog: RuntimeModel | null;
  thinking: string | null;
  runId: string;
  // Turn identity for pi_chunks rows. Minted at turn start alongside runId;
  // the per-turn seq counter lives on the session's LiveTurn entry, not here.
  turnId: string;
  signal?: AbortSignal;
  budgets?: SessionRunBudgets; plan?: boolean;
  // Preferred-model identity the caller resolved (startTurn's stored triple):
  // lets the engine record a fallback episode and report the restore when the
  // preferred entry resolves again. Absent on callers that only carry the
  // validated catalog, which the engine derives the identity from instead.
  want?: string | null;
  fallback?: ModelFallback | null;
}

export interface TurnRuntime {
  via: string;
  model: string;
  provider: string;
  thinking: string | null;
  stub: boolean;
  hint?: string;
  fallback?: string;
  restored?: string;
}

export interface TurnSink {
  push(type: string, body: unknown): void;
  live?(frame: unknown): void;
  done(runId: string, turn: SessionTurn, runtime: TurnRuntime): void;
  fail(runId: string, error: string, hint: string, status: number, opened: boolean): void;
  aborted(runId: string): void;
}


// executeTurn is the turn boundary for the pi_runs ledger: one row opens
// here (fence plus the head cursor as the turn found it) and the row is
// deleted only after the caller's commit landed inside sink.done. Failures
// and aborts forward untouched so the row survives for the recovery scan,
// which re-drives via recordAttempt and never re-opens.
export async function executeTurn(host: StreamHost, input: TurnInput, sink: TurnSink): Promise<void> {
  const fence = host.readFence();
  openPiRun(host.sql, host.sid, input.turnId, fence?.fence ?? "", entryHead(host.sql, host.sid).head);
  // Arm the first recovery scan for this turn: without it, an orphaned row
  // would sit until some unrelated wake re-arms the scan. Earliest-deadline
  // mux keeps this to one row; the scan owns re-arming from here. pokeAlarm
  // reflects the row in the real slot so the wake survives a restart.
  scheduleJob(host.sql, RECOVERY_JOB, Date.now() + RECOVERY_SCAN_MS);
  await host.pokeAlarm();
  // Test-only chaos seam: PI_TEST_HOLD_TURN_MS parks the turn open (row plus
  // prompt committed, no model output yet) so kill -9 proofs can land
  // mid-turn deterministically instead of racing a ~25ms stub turn. Never
  // set in production; capped so a stray value cannot wedge the DO.
  const holdMs = Number((host.runtimeEnv as unknown as Record<string, unknown>).PI_TEST_HOLD_TURN_MS ?? 0);
  if (Number.isFinite(holdMs) && holdMs > 0) {
    const gate = Promise.withResolvers<void>();
    setTimeout(() => gate.resolve(), Math.min(holdMs, 120000));
    await gate.promise;
  }
  try {
    await executeTurnInner(host, input, {
      push: (type, body) => sink.push(type, body),
      live: sink.live === undefined ? undefined : (frame) => sink.live?.(frame),
      done: (doneId, turn, runtime) => {
        sink.done(doneId, turn, runtime);
        try {
          commitPiRun(host.sql, input.turnId);
        } catch {
          // Commit already landed; a leftover row reads as a
          // fully-committed orphan whose suffix merge emits zero deltas.
        }
      },
      fail: (failId, error, hint, status, opened) => sink.fail(failId, error, hint, status, opened),
      aborted: (abortId) => sink.aborted(abortId),
    });
  } finally {
    await host.releaseKeepalive();
  }
}
// Re-drives an orphaned turn to completion under its original turnId. The
// fresh model run regenerates the turn's bytes; the first skipDeltas pushes
// are dropped (prompt plus already-committed prefix, never re-emitted), the
// rest land as entries with chunk seqs continuing at startSeq. Exact under
// deterministic output, best-effort otherwise. Stub turns are deterministic
// (read seed.txt, then the bash marker), so the same path covers them:
// re-execution is side-effect-free and the prefix drop keeps every
// committed entry single. Runs inside the session queue
// so it never interleaves a live turn; rotates no fence and sends no socket
// frames (alarm context has neither). Failures throw so the scan records the
// attempt; success closes the ledger row via executeTurn's done wrapper.
export interface RedriveSink {
  report(failure: { error: string; hint: string; turnId: string }): void;
}

export async function redriveTurn(host: StreamHost, input: RedriveInput & { skipDeltas: number }, sink?: RedriveSink | null): Promise<void> {
  let reported = false;
  const report = (error: string, hint: string): void => {
    reported = true;
    try {
      sink?.report({ error, hint, turnId: input.turnId });
    } catch {
      // Reporting never breaks the throw the recovery scan records.
    }
  };
  if (input.prompt === null) {
    report("redrive_no_prompt", "the turn prompt never committed; the scan cannot replay a turn without one");
    throw new Error("redrive needs the turn prompt");
  }
  const dummySock: StreamSocket = { send() {}, close() {} };
  const turnController = new AbortController();
  host.live.set(host.sid, { controller: turnController, origin: "redrive", chunkTurn: null, chunkBuf: [] });
  try {
    await host.enqueue(async () => {
      const armed = host.live.get(host.sid);
      if (armed !== undefined && armed.controller.signal === turnController.signal) {
        armed.chunkTurn = { turnId: input.turnId, seq: input.nextSeq };
      }
      let seen = 0;
      const emit = (type: string, body: unknown): void => {
        seen += 1;
        if (seen > input.skipDeltas) emitEntry(host, dummySock, type, body);
      };
      const catalog = host.model === null ? null : resolveCatalogModel(host.model.provider, host.model.id);
      const effThinking = host.thinking === null ? null : clampThinkingLevel(catalog ?? {}, host.thinking);
      await executeTurn(
        host,
        { prompt: input.prompt as string, catalog, thinking: effThinking, runId: input.turnId, turnId: input.turnId, signal: turnController.signal },
        {
          push: emit,
          done: (doneId, turn, runtime) => {
            emit("result", { runId: input.turnId, result: turn.result, usage: turn.usage, runtime, ...(turn.halt ? { halt: turn.halt } : {}) });
            void doneId;
            try {
              closeRun(host.sql, host.sid, input.turnId);
            } catch {
            }
            try {
              bumpSessionTotals(host.sql, host.sid, turn.usage);
            } catch {
            }
          },
          fail: () => {
            report("redrive_failed", "the re-driven turn failed; the scan records the attempt and backs off");
            throw new Error("re-drive failed");
          },
          aborted: () => {
            report("redrive_aborted", "the re-driven turn aborted; the scan records the attempt and backs off");
            throw new Error("re-drive aborted");
          },
        },
      );
    });
  } catch (e) {
    if (!reported) {
      const out = shaped(e, "re-drive failed", "the scan records the attempt and retries with backoff");
      report("redrive_error", out.hint);
    }
    throw e;
  } finally {
    clearSteers(host.sql, input.turnId);
    if (host.live.get(host.sid)?.controller === turnController) host.live.delete(host.sid);
  }
}

// WS frame batching for ephemeral live (toolUpdate) frames: the first
// partial per live turn waits a microtask, but a second partial arriving
// while one is held flushes the held frame synchronously in order and holds
// the newcomer, so a burst delivers every update instead of only the latest.
// Entry/result/error frames bypass this and stay synchronous, so durable
// broadcast order never changes.
interface LiveBatch {
  pending: unknown;
  queued: boolean;
  host: StreamHost;
  sid: string;
  turn: object;
}

const liveBatches = new WeakMap<object, LiveBatch>();

function emitLive(host: StreamHost, frame: unknown): void {
  const turn = host.live.get(host.sid);
  if (turn === undefined) {
    broadcast(host, frame);
    return;
  }
  let batch = liveBatches.get(turn);
  if (batch === undefined) {
    batch = { pending: frame, queued: false, host, sid: host.sid, turn };
    liveBatches.set(turn, batch);
  } else if (batch.pending !== undefined) {
    const held = batch.pending;
    batch.pending = frame;
    batch.host = host;
    broadcast(host, held);
  } else {
    batch.pending = frame;
    batch.host = host;
  }
  if (batch.queued) return;
  batch.queued = true;
  const current = batch;
  queueMicrotask(() => {
    current.queued = false;
    const pending = current.pending;
    current.pending = undefined;
    // The turn ended while queued: drop the hint instead of broadcasting
    // stale progress after the result frame.
    if (host.live.get(current.sid) !== current.turn) return;
    if (pending !== undefined) broadcast(current.host, pending);
  });
}

async function executeTurnInner(host: StreamHost, input: TurnInput, sink: TurnSink): Promise<void> {

  let resolved: TurnModel;
  try {
    resolved = resolveTurnModel(host.runtimeEnv, input.catalog);
  } catch (e) {
    const out = shaped(e, "unknown model", "retry with a catalog model");
    sink.fail(input.runId, out.error, out.hint, 404, false);
    return;
  }
  const wantNow = input.want ?? (input.catalog === null ? null : `${input.catalog.provider}/${input.catalog.id}`);
  const fell = input.fallback ?? null;
  let fallbackNote: string | null = null;
  let restoredNote: string | null = null;
  if (fell !== null) {
    setFallback(host.sql, host.sid, fell.want, fell.used);
    fallbackNote = `unknown model ${fell.want}; fell back to ${fell.used}`;
  } else if (wantNow !== null) {
    const prev = getFallback(host.sql, host.sid);
    if (prev !== null) {
      clearFallback(host.sql, host.sid);
      restoredNote = `back on ${wantNow} after falling back from ${prev.want} to ${prev.used}`;
    }
  }
  try {
    const session = createAgentSession({
      files: host.files,
      ws: host.ws,
      shell: host.shell,
      model: resolved.model,
      apiKey: resolved.stub ? undefined : resolveProviderKey(host.runtimeEnv, resolved.provider),
      history: { leaf: sessionLeaf(host.sql, host.sid), readEntries: (after, limit) => listEntries(host.sql, host.sid, { after, limit }) },
      sessionId: host.sid,
      cacheRetention: host.retention,
      plan: input.plan,
    });
    const turn = await session.run(input.prompt, {
      signal: input.signal,
      thinking: input.thinking,
      budgets: input.budgets,
      onAgent: (agent) => {
        const live = host.live.get(host.sid);
        if (live === undefined || live.controller.signal !== input.signal) return;
        live.agent = agent;
        if (input.signal?.aborted === true) return;
        for (const s of listSteers(host.sql, input.runId)) {
          if (s.applied) continue;
          agent.steer({ role: "user", content: s.text, timestamp: Date.now() });
          markSteerApplied(host.sql, input.runId, s.seq);
        }
      },
      onUpdate: (event) => {
        if (event.kind === "toolCall") sink.push("toolCall", { runId: input.runId, id: event.id, tool: event.tool, args: event.args });
        else if (event.kind === "toolResult") sink.push("toolResult", { runId: input.runId, id: event.id, tool: event.tool, args: event.args, output: event.output });
        else if (event.kind === "toolUpdate") sink.live?.({ live: { runId: input.runId, kind: "toolUpdate", id: event.id, text: event.text } });
        else if (event.kind === "text") sink.push("text", { runId: input.runId, delta: event.delta });
        else sink.push("thinking", { runId: input.runId, delta: event.delta });
      },
    });
    sink.done(input.runId, turn, {
      via: turn.via,
      model: turn.model,
      provider: resolved.provider,
      thinking: input.thinking,
      stub: resolved.stub,
      ...(resolved.stub && input.catalog !== null ? { hint: `no key for provider ${resolved.provider}; running the stub model` } : {}),
      ...(fallbackNote === null ? {} : { fallback: fallbackNote }),
      ...(restoredNote === null ? {} : { restored: restoredNote }),
    });
    if (maybeMarkForCompaction(host.sql, host.sid)) await host.scheduleAlarm();
    else if (compactionPending(host.sql, host.sid)) await host.scheduleAlarm();
  } catch (e) {
    if (input.signal?.aborted) {
      sink.aborted(input.runId);
      return;
    }
    const out = shaped(e, "run failed", "retry the prompt with a simpler request");
    sink.fail(input.runId, out.error, out.hint, 500, true);
  }
}

async function startTurn(
  host: StreamHost,
  sock: StreamSocket,
  prompt: string,
  fence: unknown,
  expected: unknown,
  hasFence: boolean,
  budgets?: SessionRunBudgets,
): Promise<void> {
  const runId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const turnController = new AbortController();
  // User intent preempts background replay: abort a live redrive for this
  // sid before arming the client turn. Client-origin entries are never
  // aborted here; racing clients still resolve through the fence below.
  const live = host.live.get(host.sid);
  if (live !== undefined && live.origin === "redrive") live.controller.abort();
  host.live.set(host.sid, { controller: turnController, origin: "client", chunkTurn: null, chunkBuf: [] });
  await host.enqueue(async () => {
    const armed = host.live.get(host.sid);
    if (armed !== undefined && armed.controller.signal === turnController.signal) armed.chunkTurn = { turnId, seq: 0 };
    const emit = (type: string, body: unknown): void => emitEntry(host, sock, type, body);
    try {
      if (turnController.signal.aborted) {
        emit("interrupted", { runId });
        sock.send({ aborted: true, runId });
        return;
      }
      const rot = checkedRotate(host.readFence(), hasFence ? { fence, expected } : undefined, "retry the turn with both {fence, expected}, or omit both", null);
      if (rot !== null && "status" in rot) {
        if (rot.status === 400) {
          sock.send(rot.body);
          return;
        }
        sock.send(rot.body);
        sock.close(rot.status === 403 ? CLOSE_FENCED : CLOSE_CONFLICT, rot.body.hint);
        return;
      }
      const held: { fence: string; revision: number } | null = rot === null
        ? null
        : { fence: fence as string, revision: expected as number };
      const sink: TurnSink = {
        push: emit,
        live: (frame) => emitLive(host, frame),
        done: (doneId, turn, runtime) => {
          emit("result", { runId: doneId, result: turn.result, usage: turn.usage, runtime, ...(turn.halt ? { halt: turn.halt } : {}) });
          try {
            closeRun(host.sql, host.sid, doneId);
            bumpSessionTotals(host.sql, host.sid, turn.usage);
          } catch {
          }
          const steers = steerOutcome(host.sql, doneId);
          if (held !== null) {
            const next = { fence: crypto.randomUUID(), revision: held.revision + 1 };
            if (!host.casRotateFence(held.fence, held.revision, next)) {
              const cur = host.readFence();
              sock.send({ error: "revision conflict", hint: "a concurrent holder rotated mid-turn; re-claim and retry", revision: cur?.revision ?? 0 });
              sock.close(CLOSE_CONFLICT, "concurrent rotation mid-turn");
              return;
            }
            sock.send({ done: true, turnId, fence: next.fence, revision: next.revision, result: turn.result, runtime, usage: turn.usage, steers, ...(turn.halt ? { halt: turn.halt } : {}) });
          } else sock.send({ done: true, turnId, result: turn.result, runtime, usage: turn.usage, steers, ...(turn.halt ? { halt: turn.halt } : {}) });
        },
        fail: (failId, error, hint) => {
          try {
            emit("error", { runId: failId, error });
          } catch {
          }
          try {
            closeRun(host.sql, host.sid, failId);
          } catch {
          }
          sock.send({ error, hint, steers: steerOutcome(host.sql, failId) });
        },
        aborted: (abortId) => {
          host.sql.exec("UPDATE runs SET status = ? WHERE sid = ? AND runId = ?", "interrupted", host.sid, abortId);
          emit("interrupted", { runId: abortId });
          sock.send({ aborted: true, runId: abortId, steers: steerOutcome(host.sql, abortId) });
        },
      };
      // Ledger row opens before the first entry lands: a kill between the
      // prompt commit and executeTurn must still leave a row for the scan.
      // executeTurn repeats all three calls as a backstop (redrive path has
      // no startTurn); INSERT OR IGNORE plus job idempotence keep both safe.
      openPiRun(host.sql, host.sid, turnId, host.readFence()?.fence ?? "", entryHead(host.sql, host.sid).head);
      scheduleJob(host.sql, RECOVERY_JOB, Date.now() + RECOVERY_SCAN_MS);
      await host.pokeAlarm();
      openRun(host.sql, host.sid, runId);
      emit("prompt", { runId, prompt });
      let chained: { catalog: RuntimeModel | null; want: string | null; fallback: ModelFallback | null };
      try {
        chained = chainCatalog(host.runtimeEnv, host.model);
      } catch (e) {
        const out = shaped(e, "run failed", "retry the prompt with a simpler request");
        sink.fail(runId, out.error, out.hint, 404, true);
        return;
      }
      const effThinking = host.thinking === null ? null : clampThinkingLevel(chained.catalog ?? {}, host.thinking);
      await executeTurn(host, { prompt, catalog: chained.catalog, thinking: effThinking, runId, turnId, signal: turnController.signal, budgets, want: chained.want, fallback: chained.fallback }, sink);
    } catch (e) {
      const out = shaped(e, "turn failed", "retry the prompt with a simpler request");
      try {
        emitEntry(host, sock, "error", { runId, error: out.error });
      } catch {
      }
      try {
        closeRun(host.sql, host.sid, runId);
      } catch {
      }
      sock.send({ error: out.error, hint: out.hint });
    } finally {
      if (host.live.get(host.sid)?.controller === turnController) host.live.delete(host.sid);
      clearSteers(host.sql, runId);
    }
  });
}
