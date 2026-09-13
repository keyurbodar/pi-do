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
import { peekReplyFor } from "./replyStore";
import type { ToolCallView, TurnInboxMessage, TurnViewState } from "../thread/types";

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

/** Delegated sub-task card: child bot avatar+name, task text, status pill. */
export interface DelegationVM {
  kind: "delegation";
  id: string;
  childBot: string;
  task: string;
  state: "working" | "done" | "failed";
}

/** Inline question with quick-reply options plus a free-text field. */
export interface UserInputVM {
  kind: "userinput";
  id: string;
  question: string;
  options: string[];
}

/** Inbox wake: the teammate messages that triggered this turn. */
export interface InboxEventVM {
  kind: "inbox";
  id: string;
  messages: { label: string; thread: string | null; text: string }[];
}

 /** Bot bubble carrying an optional group-thread sender label. */
 export interface SenderMessageBubbleVM extends MessageBubbleVM {
   /** Resolved sender name (from turn.senderId via the bots param); unset for 1:1 turns. */
   senderLabel?: string;
   /** Reply quote passed straight from turn.replyTo (label/text only); never invented. */
   replyTo?: { label: string; text: string };
   /** Reactions passed straight from turn.reactions as-is; never invented. */
   reactions?: { emoji: string; by: string }[];
 }
 
/** Everything the timeline renders, including the mapper-local rows. */
export type ChatItemVM = ThreadItemVM | ThinkingRowVM | SystemEventVM | DelegationVM | UserInputVM | SenderMessageBubbleVM | InboxEventVM;

/**
 * One turn → ordered timeline items:
 *   prompt            → user MessageBubbleVM
 *   delegation        → DelegationVM right under the prompt
 *   thinking parts    → ThinkingRowVM (collapsed "Thought for Ns")
 *   text parts        → bot MessageBubbleVM, emitted only once the turn
 *                       settles (streaming turns emit none — the dots
 *                       activity row covers the nothing-yet case)
 *   tools parts       → consecutive parts of the same run collapse into ONE
 *                       StatusCardVM titled by the first tool (or "Working"),
 *                       rows via viewModel.toolRowOf, card state via
 *                       viewModel.stateOfTurn
 *   error / halt      → trailing failed StatusCardVM carrying turn.error
 *   approval          → pending ApprovalVM trailing the content
 *   userInput         → UserInputVM trailing the approval
 *   systemEvent       → SystemEventVM prepended above the turn's content
 *   routineId         → "Routine · <id>" SystemEventVM above the prompt
 *   inbox             → InboxEventVM (teammate messages that woke the turn),
 *                       sender sids resolved to names via the bots param
 *   interBotFrom      → InterBotMessageVM inserted before the first bot text
 *                       bubble ("Messages from Account Manager and Chief")
 *   senderId          → bot bubbles carry senderLabel, resolved via the
 *                       optional bots param (default [])
 *   replyTo           → bubbles carry { label, text } straight from
 *                       turn.replyTo; absent unless the turn sets it
 *   reactions         → bubbles carry turn.reactions through as-is;
 *                       absent unless the turn sets them
 */
export function turnToItems(turn: TurnViewState, bots: RosterBot[] = []): ChatItemVM[] {
  const items: ChatItemVM[] = [];

  if (turn.systemEvent !== undefined && turn.systemEvent.length > 0) {
    items.push({ kind: "system", id: `${turn.runId}:system`, text: turn.systemEvent });
  }
  if (turn.routineId !== undefined && turn.routineId.length > 0) {
    items.push({ kind: "system", id: `${turn.runId}:routine`, text: `Routine · ${turn.routineId}` });
  }
  if (turn.inbox !== undefined) {
    const inbox: InboxEventVM = {
      kind: "inbox",
      id: `${turn.runId}:inbox`,
      messages: turn.inbox.map((msg: TurnInboxMessage) => ({
        label: msg.from !== null ? (bots.find((b) => b.id === msg.from)?.name ?? msg.from) : "inbox",
        thread: msg.thread,
        text: msg.text,
      })),
    };
    items.push(inbox);
  }
  // Fixture bot turns carry an empty prompt (the exchange's prompt is its
  // own user turn); real turns always have one — reducer rejects empties.
  if (turn.prompt.length > 0) {
    const promptBubble: SenderMessageBubbleVM = {
      id: `${turn.runId}:prompt`,
      role: "user",
      text: turn.prompt,
      attachments: [],
      ts: turn.startedAt,
    };
    if (turn.replyTo !== undefined) {
      promptBubble.replyTo = { label: turn.replyTo.label, text: turn.replyTo.text };
    } else {
      const staged = peekReplyFor(turn.prompt);
      if (staged !== null) {
        promptBubble.replyTo = { label: staged.label, text: staged.text };
      }
    }
    if (turn.reactions !== undefined) promptBubble.reactions = turn.reactions;
    items.push(promptBubble);
  }

  // Delegated sub-task card sits right under the prompt: the spawn precedes
  // any thinking/tools/text the parent (or child) streams afterwards.
  if (turn.delegation !== undefined) {
    const delegation: DelegationVM = {
      kind: "delegation",
      id: `${turn.runId}:delegation`,
      childBot: turn.delegation.childBot,
      task: turn.delegation.task,
      state: turn.delegation.state,
    };
    items.push(delegation);
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
      // While the turn streams only the dots ActivityRow shows; the full
      // bubble appears whole once the turn settles (ThreadPane pops it in).
      if (turn.status === "streaming") return;
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
        if (turn.replyTo !== undefined) {
          bubble.replyTo = { label: turn.replyTo.label, text: turn.replyTo.text };
        }
        if (turn.reactions !== undefined) bubble.reactions = turn.reactions;
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

  // Approval gate and inline question trail the turn's content: the human
  // answers, then the run (or fixture script) continues.
  if (turn.approval !== undefined) {
    items.push({
      id: `${turn.runId}:approval`,
      title: turn.approval.title,
      description: turn.approval.description,
      state: "pending",
    });
  }
  if (turn.userInput !== undefined) {
    const input: UserInputVM = {
      kind: "userinput",
      id: `${turn.runId}:userinput`,
      question: turn.userInput.question,
      options: turn.userInput.options,
    };
    items.push(input);
  }

  return items;
}


// Re-exported so ThreadPane and tests import the whole VM vocabulary from
// one place without reaching into thread/viewModel directly.
export type { ApprovalVM, InterBotMessageVM, MessageBubbleVM, StatusCardVM, ThreadItemVM };
