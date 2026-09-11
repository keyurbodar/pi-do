// stream-codec.ts — stream frame codec: socket handling plus entry/chunk
import { appendChunk, appendChunkBatch, serializeChunkBody, type BufferedChunk } from "pi-cf/store/chunks";
// persistence for one broadcast frame. Separated from the turn engine
// (stream-engine.ts) so transport framing can evolve without touching turn
// policy. Import through ./stream, which re-exports both halves.
import { appendEntry, getEntry, runInSyncTx, type EntriesSql } from "pi-cf/store/entries";
import { touchPiRun } from "pi-cf/store/runs";
import type { FileStore } from "pi-cf/store/vfs-dofs";
import type { RuntimeEnv } from "./model-runtime";
import type { Agent } from "@earendil-works/pi-agent-core";

export interface StreamShell {
  exec(input: {
    command: string;
    cwd?: string;
  }): Promise<{ stdout: string; stderr: string; exit: number; timedOut: boolean }>;
}

export interface StreamHost {
  sql: EntriesSql;
  ws: string;
  sid: string;
  files: FileStore;
  shell: StreamShell;
  runtimeEnv: RuntimeEnv;
  thinking: string | null;
  retention: "short" | "long";
  model: { provider: string; id: string } | null;
  workspaceKnown: boolean;
  sessionKnown: boolean;
  readFence(): { fence: string | null; revision: number } | null;
  casRotateFence(oldFence: string, oldRevision: number, next: { fence: string; revision: number }): boolean;
  live: Map<string, LiveTurn>;
  sockets(): WebSocket[];
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  scheduleAlarm(): Promise<void>;
  pokeAlarm(): Promise<void>;
  // Reflect the job table in the real alarm slot without adding jobs: used
  // after arming the recovery scan so a row written pre-crash still wakes
  // the DO post-restart. A bare row with no setAlarm never fires.
  holdKeepalive(): Promise<void>;
  releaseKeepalive(): Promise<void>;
}

// Turn-scoped live state, shared across the host objects that span one
// session turn (prompt message, steer messages, alarm callbacks all build
// their own StreamHost over this same map). The chunk cursor lives here so
// every emitEntry during the turn — including a mid-turn steer on a fresh
// host — tags the same turn identity with a gapless sequence. The entry is
// deleted at turn end; the cursor never outlives the turn and is never
// global.
export interface LiveTurn {
  controller: AbortController;
  agent?: Agent;
  // Which open path armed this entry: a client turn preempts a live
  // redrive, never another client turn (racing clients resolve via 409).
  origin: "client" | "redrive";
  chunkTurn: { turnId: string; seq: number } | null;
  // Packed chunk deltas awaiting a boundary flush (perf pack: text and
  // thinking deltas buffer here instead of one INSERT per delta; tool and
  // turn-boundary frames flush immediately with identical row shape).
  chunkBuf: BufferedChunk[];
}

export interface StreamAttachment {
  ws: string;
  sid: string;
}

export interface StreamSocket {
  send(frame: unknown): void;
  close(code: number, reason: string): void;
}

export const CLOSE_UNKNOWN = 4404;
export const CLOSE_FENCED = 4403;
export const CLOSE_CONFLICT = 4409;

function shortReason(hint: string): string {
  return hint.length > 120 ? hint.slice(0, 120) : hint;
}

export function wrapSocket(ws: WebSocket): StreamSocket {
  return {
    send(frame: unknown): void {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
      }
    },
    close(code: number, reason: string): void {
      try {
        ws.close(code, shortReason(reason));
      } catch {
      }
    },
  };
}

export function broadcast(host: StreamHost, frame: unknown): void {
  for (const ws of host.sockets()) {
    const att = readAttachment(ws);
    if (att === null || att.ws !== host.ws || att.sid !== host.sid) continue;
    wrapSocket(ws).send(frame);
  }
}

// Adaptive flush budgets for packed text deltas: flush the buffer when it
// holds this many deltas or this many serialized bytes, whichever comes
// first. Structural frames (tool calls, results, errors, interrupts) and
// turn boundaries always flush immediately, so tool pair chunks stay paired
// with their entries in one transaction and only free-text tail rows can
// ever lag the entry cursor (recovered through the entry-count floor on
// the fresh redrive path).
const CHUNK_FLUSH_ROWS = 16;
const CHUNK_FLUSH_BYTES = 65536;

function chunkBufferedBytes(buf: readonly BufferedChunk[]): number {
  let bytes = 0;
  for (const row of buf) bytes += row.body.length;
  return bytes;
}

export function emitEntry(host: StreamHost, sock: StreamSocket, type: string, body: unknown): void {
  const live = host.live.get(host.sid);
  const chunk = live?.chunkTurn ?? null;
  // Free-text streaming deltas pack into boundary-aware segments; every
  // other frame type pins its chunk row in the same transaction as its
  // entry, exactly like the pre-pack path.
  const packable = chunk !== null && (type === "text" || type === "thinking");
  let cursor = -1;
  try {
    // Entry row first so the chunk row can pin its mirrored cursor; entry
    // and the ledger touch land in one synchronous transaction, so a
    // failed frame leaves neither an unmirrored entry nor an updatedAt
    // running ahead of durable data.
    runInSyncTx(host.sql, () => {
      cursor = appendEntry(host.sql, host.sid, type, body);
      if (chunk !== null && live !== undefined) {
        if (packable) {
          const stored = serializeChunkBody(body);
          const buffered = chunkBufferedBytes(live.chunkBuf) + stored.length;
          if (live.chunkBuf.length >= CHUNK_FLUSH_ROWS || buffered >= CHUNK_FLUSH_BYTES) {
            live.chunkBuf.push({ seq: chunk.seq, body: stored, cursor });
            const pending = live.chunkBuf;
            live.chunkBuf = [];
            appendChunkBatch(host.sql, host.sid, chunk.turnId, pending);
          } else {
            live.chunkBuf.push({ seq: chunk.seq, body: stored, cursor });
          }
        } else {
          const pending = live.chunkBuf;
          live.chunkBuf = [];
          if (pending.length === 0) appendChunk(host.sql, host.sid, chunk.turnId, chunk.seq, body, cursor);
          else {
            pending.push({ seq: chunk.seq, body: serializeChunkBody(body), cursor });
            appendChunkBatch(host.sql, host.sid, chunk.turnId, pending);
          }
        }
        touchPiRun(host.sql, chunk.turnId);
      }
    });
    if (chunk !== null) chunk.seq += 1;
  } catch (e) {
    live?.controller.abort();
    // Dropping the sid from the live map orphans the open pi_runs row so the recovery scan redrives it.
    host.live.delete(host.sid);
    sock.send({ error: e instanceof Error ? e.message : String(e), hint: "chunk persist failed; the turn is orphaned and the recovery scan will redrive it" });
    sock.close(CLOSE_UNKNOWN, "chunk persist failed; turn orphaned for the recovery scan");
    return;
  }
  let row: ReturnType<typeof getEntry> = null;
  try {
    row = getEntry(host.sql, host.sid, cursor);
  } catch {
    row = null;
  }
  if (row !== null) broadcast(host, { entry: row });
}

export function readAttachment(ws: WebSocket): StreamAttachment | null {
  try {
    const raw: unknown = ws.deserializeAttachment();
    if (raw === null || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec["ws"] !== "string" || rec["ws"].length === 0) return null;
    if (typeof rec["sid"] !== "string" || rec["sid"].length === 0) return null;
    return { ws: rec["ws"] as string, sid: rec["sid"] as string };
  } catch {
    return null;
  }
}
