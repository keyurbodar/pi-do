// components/chat/mapper.ts — pure TurnViewState → timeline view-model
// mapping for the akeru-style ThreadPane. No React, no store access: the
// orchestrator unit-tests this file directly.
//
// Contract additions (reported to Main): ThinkingRowVM and SystemEventVM
// live HERE, not in thread/viewModel.ts, per the wave-1 brief. ChatItemVM =
// ThreadItemVM | ThinkingRowVM | SystemEventVM is what ThreadPane renders.
import type { RosterBot } from "../../lib/roster";
import type {
  ApprovalVM,
  InterBotMessageVM,
  MessageBubbleVM,
  StatusCardVM,
  ThreadItemVM,
} from "../thread/viewModel";
import { stateOfTurn, toolRowOf } from "../thread/viewModel";
import type { ToolCallView, TurnViewState } from "../thread/types";

/** Centered system row ("Created routine · Month-end close"). */
export interface SystemEventVM {
  kind: "system";
  id: string;
  text: string;
}

/** Collapsed reasoning row: "Thought for Ns" (akeru ThinkingActivityRow). */
export interface ThinkingRowVM {
  kind: "thinking";
  id: string;
  text: string;
  /** Reasoning duration in ms; null while still streaming. */
  ms: number | null;
}

/** Bot bubble carrying an optional group-thread sender label. */
export interface SenderMessageBubbleVM extends MessageBubbleVM {
  /** Resolved sender name (from turn.senderId via the bots param); unset for 1:1 turns. */
  senderLabel?: string;
}

/** Everything the timeline renders, including the mapper-local rows. */
export type ChatItemVM = ThreadItemVM | ThinkingRowVM | SystemEventVM;

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
 *   systemEvent       → SystemEventVM prepended above the turn's content
 *   interBotFrom      → InterBotMessageVM inserted before the first bot text
 *                       bubble ("Messages from Account Manager and Chief")
 *   senderId          → bot bubbles carry senderLabel, resolved via the
 *                       optional bots param (default [])
 *
 * InterBotMessageVM / ApprovalVM are renderable (see InterBotDivider /
 * ApprovalCard); only interBotFrom drives emission today.
 */
export function turnToItems(turn: TurnViewState, bots: RosterBot[] = []): ChatItemVM[] {
  const items: ChatItemVM[] = [];

  if (turn.systemEvent !== undefined && turn.systemEvent.length > 0) {
    items.push({ kind: "system", id: `${turn.runId}:system`, text: turn.systemEvent });
  }
  // Fixture bot turns carry an empty prompt (the exchange's prompt is its
  // own user turn); real turns always have one — reducer rejects empties.
  if (turn.prompt.length > 0) {
    items.push({
      id: `${turn.runId}:prompt`,
      role: "user",
      text: turn.prompt,
      attachments: [],
      ts: turn.startedAt,
    });
  }

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
    pendingCalls = [];
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
        const sender = turn.senderId !== undefined ? bots.find((b) => b.id === turn.senderId) : undefined;
        const bubble: SenderMessageBubbleVM = {
          id: `${turn.runId}:text:${index}`,
          role: "bot",
          text: part.text,
          attachments: [],
          ts: turn.endedAt,
        };
        if (sender !== undefined) bubble.senderLabel = sender.name;
        items.push(bubble);
      }
    } else {
      for (const id of part.ids) {
        const call = turn.calls.find((c) => c.id === id);
        if (call) pendingCalls.push(call);
      }
    }
  });
  flushTools();

  // Inter-bot divider sits directly above the first bot text bubble.
  if (turn.interBotFrom !== undefined && turn.interBotFrom.length > 0) {
    const firstBotText = items.findIndex(
      (item) => "role" in item && item.role === "bot",
    );
    const divider: InterBotMessageVM = {
      id: `${turn.runId}:inter-bot`,
      fromBotIds: turn.interBotFrom,
      text: "Messages from",
    };
    if (firstBotText >= 0) items.splice(firstBotText, 0, divider);
    else items.push(divider);
  }

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
