// View-model contract for the akeru-style thread UI. Wave-1 agents code
// against these types; the pure mapping from TurnViewState lives with the
// timeline implementation (wt-thread), not here.

import type { ToolCallView, TurnStatus, TurnViewState } from "./types";

export type ItemState = "running" | "done" | "failed";

/** One checklist row inside a status card ("Salesforce → list pulled · 52 accounts"). */
export interface ToolStatusRow {
  /** Tool or system name, rendered bold ("Salesforce"). */
  label: string;
  /** Outcome detail after the arrow ("list pulled · 52 accounts"); null while running. */
  detail: string | null;
  state: ItemState;
}

/** A grouped tool-activity card shown as one bubble in the timeline. */
export interface StatusCardVM {
  id: string;
  /** Card title ("Computer", "Outreach queue"). */
  title: string;
  rows: ToolStatusRow[];
  state: ItemState;
}

export interface AttachmentVM {
  id: string;
  kind: "image" | "file";
  name: string;
  /** Object URL for staged files, worker URL for received ones. */
  url: string;
}

export interface MessageBubbleVM {
  id: string;
  role: "user" | "bot";
  text: string;
  attachments: AttachmentVM[];
  /** Epoch ms when the message landed; null while streaming. */
  ts: number | null;
}

/** A divider row: "Messages from Account Manager and Chief". */
export interface InterBotMessageVM {
  id: string;
  /** Roster bot ids whose messages were folded into this turn. */
  fromBotIds: string[];
  text: string;
}

export interface ApprovalVM {
  id: string;
  title: string;
  description: string;
  state: "pending" | "approved" | "rejected";
}

export type ThreadItemVM =
  | MessageBubbleVM
  | StatusCardVM
  | InterBotMessageVM
  | ApprovalVM;

/** Composer attachment staging shape (wt-composer owns the store). */
export interface StagedAttachment {
  id: string;
  file: File;
  previewUrl: string | null;
}

/** Tool-call → status-row label policy: the tool name capitalizes into the
 * row label; output's first line becomes the detail. Shared so the timeline
 * and any future card rendering agree on what a row says. */
export function toolRowOf(call: ToolCallView): ToolStatusRow {
  const firstLine = call.output?.split("\n")[0].trim() ?? null;
  return {
    label: call.tool,
    detail: call.done ? firstLine : null,
    state: !call.done ? "running" : call.output === null ? "failed" : "done",
  };
}

/** Turn status → card state. Kept here so both wave agents map identical. */
export function stateOfTurn(status: TurnStatus, turn: TurnViewState): ItemState {
  if (status === "streaming") return "running";
  if (status === "error" || turn.halt !== null) return "failed";
  return "done";
}
