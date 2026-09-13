// components/chat/useFixturePlayback.ts — scripted demo playback per seed
// bot. On first selection of a bot (once per bot per page load, tracked in a
// module-level set so remounts and StrictMode's double effect don't replay),
// the bot's fixture script plays with timers: the prompt lands as a done
// user turn, then the bot turn opens streaming and grows thinking → tool
// rows flipping running→done → text word-by-word, then settles to done.
// Multi-sender (group) exchanges carry segments instead of a single
// response: each segment streams as its own turn in order, so the group send
// plays as an interleaved per-sender round-robin, not all at once. Turn
// shapes match thread/reducer's TurnViewState exactly, so ThreadPane renders
// fixture turns identically to live ones. Every timer is cleared on botId
// change or unmount.
import { useEffect, useState } from "react";

import type { TurnViewState } from "../thread/types";
import { FIXTURE_SCRIPTS, type FixtureResponse, type FixtureScript } from "./fixtureScripts";

/** Prompt lands this long after the bot is selected. */
export const USER_DELAY_MS = 350;
/** Bot turn opens this long after its prompt. */
export const BOT_DELAY_MS = 900;
/** "Thinking…" dwells this long before its scripted duration locks in. */
const THINK_DWELL_MS = 1200;
/** Per tool row: appears running, flips done one tick later; rows stagger one tick apart. */
const TOOL_TICK_MS = 600;
/** Text grows one word per tick. */
const WORD_TICK_MS = 45;
/** Streaming status lingers this long after the last word before settling to done. */
const DONE_PAD_MS = 250;
/** Pause between scripted exchanges. */
const EXCHANGE_GAP_MS = 800;

/** Bots already played this page load — first time per bot only. */
const played = new Set<string>();

function baseTurn(
  runId: string,
  prompt: string,
  status: TurnViewState["status"],
  at?: number,
  meta?: {
    senderId?: string;
    systemEvent?: string;
    interBotFrom?: string[];
    delegation?: TurnViewState["delegation"];
    userInput?: TurnViewState["userInput"];
    approval?: TurnViewState["approval"];
  },
): TurnViewState {
  const ts = at ?? Date.now();
  return {
    runId,
    prompt,
    parts: [],
    startedAt: ts,
    endedAt: status === "done" ? ts : null,
    steers: [],
    calls: [],
    status,
    error: null,
    halt: null,
    hint: null,
    keyless: false,
    live: false,
    senderId: meta?.senderId,
    systemEvent: meta?.systemEvent,
    interBotFrom: meta?.interBotFrom,
    delegation: meta?.delegation,
    userInput: meta?.userInput,
    approval: meta?.approval,
  };
}

/** View-model handed to the shell: fixture turns to prepend + live indicator. */
export interface FixturePlayback {
  turns: TurnViewState[];
  playing: boolean;
}

export function useFixturePlayback(botId: string | null): FixturePlayback {
  const [turns, setTurns] = useState<TurnViewState[]>([]);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setTurns([]);
    setPlaying(false);
    if (botId === null) return;
    const script: FixtureScript | undefined = FIXTURE_SCRIPTS[botId];
    if (script === undefined || played.has(botId)) return;

    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => {
      timers.push(window.setTimeout(fn, ms));
    };
    // Clone-and-mutate the bot turn so ThreadPane sees a fresh object.
    const patch = (runId: string, fn: (turn: TurnViewState) => void) => {
      setTurns((prev) =>
        prev.map((turn) => {
          if (turn.runId !== runId) return turn;
          const draft: TurnViewState = {
            ...turn,
            parts: turn.parts.map((p) => ({ ...p })),
            calls: turn.calls.map((c) => ({ ...c })),
          };
          fn(draft);
          return draft;
        }),
      );
    };

    // Schedules one streaming bot turn opening at `from`; returns the cursor
    // where the next turn may start.
    const playBotTurn = (
      runId: string,
      meta: {
        senderId?: string;
        systemEvent?: string;
        interBotFrom?: string[];
        delegation?: TurnViewState["delegation"];
        userInput?: TurnViewState["userInput"];
        approval?: TurnViewState["approval"];
      },
      resp: FixtureResponse,
      from: number,
    ): number => {
      at(from, () => setTurns((prev) => [...prev, baseTurn(runId, "", "streaming", undefined, meta)]));
      let cursor = from;

      if (resp.thinking !== undefined) {
        const think = resp.thinking;
        at(cursor, () =>
          patch(runId, (turn) => {
            turn.parts.push({ type: "thinking", text: think.text, ms: null });
          }),
        );
        cursor += THINK_DWELL_MS;
        at(cursor, () =>
          patch(runId, (turn) => {
            const part = turn.parts.find((p) => p.type === "thinking" && p.ms === null);
            if (part && part.type === "thinking") part.ms = think.ms;
          }),
        );
      }

      if (resp.tools !== undefined && resp.tools.length > 0) {
        resp.tools.forEach((spec, j) => {
          const callId = `${runId}:tool:${j}`;
          at(cursor, () =>
            patch(runId, (turn) => {
              const call = { id: callId, tool: spec.tool, args: spec.args, output: null, done: false };
              turn.calls.push(call);
              const tail = turn.parts[turn.parts.length - 1];
              if (tail && tail.type === "tools") tail.ids.push(callId);
              else turn.parts.push({ type: "tools", ids: [callId] });
            }),
          );
          at(cursor + TOOL_TICK_MS, () =>
            patch(runId, (turn) => {
              const call = turn.calls.find((c) => c.id === callId);
              if (call) {
                call.done = true;
                call.output = spec.output;
              }
            }),
          );
          cursor += TOOL_TICK_MS;
        });
        cursor += TOOL_TICK_MS; // last row's flip lands before text starts
      }

      const words = resp.text.length > 0 ? resp.text.split(" ") : [];
      at(cursor, () =>
        patch(runId, (turn) => {
          turn.parts.push({ type: "text", text: "" });
        }),
      );
      words.forEach((_, w) => {
        at(cursor + (w + 1) * WORD_TICK_MS, () =>
          patch(runId, (turn) => {
            const tail = turn.parts[turn.parts.length - 1];
            if (tail && tail.type === "text") tail.text = words.slice(0, w + 1).join(" ");
          }),
        );
      });
      cursor += words.length * WORD_TICK_MS + DONE_PAD_MS;
      at(cursor, () =>
        patch(runId, (turn) => {
          turn.status = "done";
          turn.endedAt = turn.startedAt;
        }),
      );
      return cursor;
    };

    setPlaying(true);
    let t = USER_DELAY_MS;
    let lastDone = 0;

    script.forEach((exchange, i) => {
      const userRunId = `fixture:${botId}:${i}:prompt`;
      const botRunId = `fixture:${botId}:${i}:run`;
      const prompt = exchange.prompt;

      at(t, () => {
        // First fired timer: playback truly started (StrictMode remounts
        // clear the pending timers before this, so they can replay).
        played.add(botId);
        setTurns((prev) => [...prev, baseTurn(userRunId, prompt, "done", exchange.at)]);
      });

      const botStart = t + BOT_DELAY_MS;
      let cursor = botStart;

      const segments = exchange.segments ?? [];
      if (segments.length > 0) {
        // Multi-sender exchange: each sender's text streams in turn, with
        // the exchange timestamp shared across the round.
        segments.forEach((segment, s) => {
          cursor = playBotTurn(
            `${botRunId}:seg:${s}`,
            { senderId: segment.senderId, systemEvent: s === 0 ? exchange.systemEvent : undefined },
            { thinking: segment.thinking, tools: segment.tools, text: segment.text },
            cursor,
          );
          cursor += EXCHANGE_GAP_MS;
        });
      } else if (exchange.response !== undefined) {
      cursor = playBotTurn(
        botRunId,
        {
          senderId: exchange.senderId,
          systemEvent: exchange.systemEvent,
          interBotFrom: exchange.interBotFrom,
          delegation: exchange.delegation,
          userInput: exchange.userInput,
          approval: exchange.approval,
        },
        exchange.response,
        cursor,
      );
      }

      lastDone = cursor;
      t = cursor + EXCHANGE_GAP_MS;
    });

    at(lastDone, () => setPlaying(false));

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [botId]);

  return { turns, playing };
}
