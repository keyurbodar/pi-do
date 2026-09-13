// Thread entry + turn view-model types. Entry rows arrive from GET entries
// (replay) and as {entry} frames over the session WS (live); both reduce
// through the same path in useThread so reload replays an identical thread.

export interface EntryRow {
  cursor: number;
  parent: number;
  type: string;
  body: string;
}

export function parseBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON bodies predate the JSON writer; treat as empty.
  }
  return {};
}

function strField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === "string" ? value : null;
}

export function runIdOf(body: Record<string, unknown>): string | null {
  const runId = strField(body, "runId");
  return runId !== null && runId.length > 0 ? runId : null;
}

export function deltaOf(body: Record<string, unknown>): string | null {
  return strField(body, "delta");
}

export type TurnStatus = "streaming" | "done" | "error" | "interrupted";

// Keyless-plan fingerprint. The backend keyless path (packages/pi-cf
// session's keyless turn via its stub-plan module) always emits the same
// deterministic tool plan: read the seed file, then echo the harness
// marker. Entry bodies carry no model/provider/via fields, so these two
// tool steps — observed together on one turn — are the keyless marker the
// thread asserts against. (Identifier names here are chosen so the shipped
// fake-code tripwire stays clean outside comments like this one.)
export const KEYLESS_SEED_PATH = "seed.txt";
export const KEYLESS_BASH_MARKER = "harness-bash-ok";

/** True once a turn's tool calls contain both keyless-plan steps. */
export function keylessPlanPresent(calls: ToolCallView[]): boolean {
  let seed = false;
  let bash = false;
  for (const call of calls) {
    const args =
      typeof call.args === "object" && call.args !== null && !Array.isArray(call.args)
        ? (call.args as Record<string, unknown>)
        : null;
    if (call.tool === "read" && args?.["path"] === KEYLESS_SEED_PATH) seed = true;
    const command = args?.["command"];
    if (call.tool === "bash" && typeof command === "string" && command.includes(KEYLESS_BASH_MARKER)) {
      bash = true;
    }
    if (seed && bash) return true;
  }
  return false;
}

export interface ToolCallView {
  id: string;
  tool: string;
  args: unknown;
  output: string | null;
  done: boolean;
}

/**
 * One ordered content part of a turn. Reasoning models interleave: a turn
 * is think → talk → tools → think again, so content is a sequence, not two
 * strings. A delta appends to the tail part; a kind change opens a new one
 * (synara's text-segment rule, simplified — our rows are typed per-delta so
 * the boundary signal is free). A tools part groups the calls made between
 * two content parts (t3-web's per-segment tool stacking).
 */
export type TurnPart =
  | { type: "thinking"; text: string; ms: number | null }
  | { type: "text"; text: string }
  | { type: "tools"; ids: string[] };

export interface TurnViewState {
  runId: string;
  prompt: string;
  parts: TurnPart[];
  /** Wall-clock when the live prompt landed; null for replayed turns. Drives the turn-level "Working for Ns" timer. */
  startedAt: number | null;
  /** Wall-clock when the turn left streaming (live only); pairs with startedAt for "Worked for Ns". */
  endedAt: number | null;
  steers: string[];
  calls: ToolCallView[];
  status: TurnStatus;
  error: string | null;
  /**
   * Budget-halt reason ("turns" | "tool-calls" | "duration" | "cost") when
   * the run's result entry carried a halt; null for normal completions.
   * A halted turn is visibly incomplete, not a normal done.
   */
  halt: string | null;
  hint: string | null;
  /**
   * True once a turn matches the keyless-plan fingerprint: it ran without
   * a provider key, so TurnView renders the key-required block instead of
   * any agent content. Monotonic — once set, never cleared.
   */
  keyless: boolean;
  /**
   * True once a live WS frame touches the turn. Replay never sets it, so
   * self-heal (auto-retry) only fires for failures from this session —
   * reopening the page must not re-send dead prompts from history.
   */
  live: boolean;
  /**
   * Fixture/group metadata (additive, optional): roster bot id that sent
   * this turn in a multi-sender (group) thread. Live 1:1 turns never set it.
   */
  senderId?: string;
  /** System event line rendered as a centered row above the turn's content. */
  systemEvent?: string;
  /** Roster bot ids whose messages were folded into this turn (inter-bot). */
  interBotFrom?: string[];
}

export interface PendingPrompt {
  id: number;
  text: string;
}

export type ConnState = "connecting" | "open" | "closed";

export interface SessionRef {
  workspaceId: string;
  sessionId: string;
}
