// components/chat/mapper.ts — pure TurnViewState → timeline view-model
// mapping for the akeru-style ThreadPane. No React, no store access: the
// orchestrator unit-tests this file directly.
//
// Contract additions (reported to Main): ThinkingRowVM lives HERE, not in
// thread/viewModel.ts, per the wave-1 brief. ChatItemVM = ThreadItemVM |
// ThinkingRowVM is what ThreadPane renders.
import type {
  ApprovalVM,
  InterBotMessageVM,
  MessageBubbleVM,
  StatusCardVM,
  ThreadItemVM,
} from "../thread/viewModel";
import { stateOfTurn, toolRowOf } from "../thread/viewModel";
import type { ToolCallView, TurnViewState } from "../thread/types";

/** Collapsed reasoning row: "Thought for Ns" (akeru ThinkingActivityRow). */
export interface ThinkingRowVM {
  kind: "thinking";
  id: string;
  text: string;
  /** Reasoning duration in ms; null while still streaming. */
  ms: number | null;
}

/** Everything the timeline renders, including the mapper-local thinking row. */
export type ChatItemVM = ThreadItemVM | ThinkingRowVM;

/**
 * One turn → ordered timeline items:
 *   prompt            → user MessageBubbleVM
 *   thinking parts    → ThinkingRowVM (collapsed "Thought for Ns")
 *   text parts        → bot MessageBubbleVM (empty text skipped — the
 *                       activity row covers the nothing-yet-streamed case)
 *   tools parts       → consecutive parts of the same run collapse into ONE
 *                       StatusCardVM titled by the first tool (or "Working"),
 *                       rows via viewModel.toolRowOf, card state via
 *                       viewModel.stateOfTurn
 *   error / halt      → trailing failed StatusCardVM carrying turn.error
 *
 * InterBotMessageVM / ApprovalVM are renderable (see InterBotDivider /
 * ApprovalCard) but TurnViewState carries no metadata for them yet, so the
 * mapper never emits them.
 */
export function turnToItems(turn: TurnViewState): ChatItemVM[] {
  const items: ChatItemVM[] = [];

  items.push({
    id: `${turn.runId}:prompt`,
    role: "user",
    text: turn.prompt,
    attachments: [],
    ts: turn.startedAt,
  });

  const state = stateOfTurn(turn.status, turn);

  let pendingCalls: ToolCallView[] = [];
  const flushTools = () => {
    if (pendingCalls.length === 0) return;
    const first = pendingCalls[0];
    items.push({
      id: `${turn.runId}:tools:${first.id}`,
      title: first.tool.length > 0 ? first.tool[0].toUpperCase() + first.tool.slice(1) : "Working",
      rows: pendingCalls.map(toolRowOf),
      state,
    });
  };

  turn.parts.forEach((part, index) => {
    if (part.type === "thinking") {
      flushTools();
      items.push({
        kind: "thinking",
        id: `${turn.runId}:thinking:${index}`,
        text: part.text,
        ms: part.ms,
      });
    } else if (part.type === "text") {
      flushTools();
      if (part.text.trim().length > 0) {
        items.push({
          id: `${turn.runId}:text:${index}`,
          role: "bot",
          text: part.text,
          attachments: [],
          ts: turn.endedAt,
        });
      }
    } else {
      for (const id of part.ids) {
        const call = turn.calls.find((c) => c.id === id);
        if (call) pendingCalls.push(call);
      }
    }
  });
  flushTools();

  if (turn.error !== null && turn.error.length > 0) {
    items.push({
      id: `${turn.runId}:error`,
      title: "Failed",
      rows: [{ label: "Error", detail: turn.error, state: "failed" }],
      state: "failed",
    });
  } else if (turn.halt !== null) {
    items.push({
      id: `${turn.runId}:halt`,
      title: "Halted",
      rows: [{ label: "Budget", detail: `Run halted: ${turn.halt}`, state: "failed" }],
      state: "failed",
    });
  }

  return items;
}


// Re-exported so ThreadPane and tests import the whole VM vocabulary from
// one place without reaching into thread/viewModel directly.
export type { ApprovalVM, InterBotMessageVM, MessageBubbleVM, StatusCardVM, ThreadItemVM };
