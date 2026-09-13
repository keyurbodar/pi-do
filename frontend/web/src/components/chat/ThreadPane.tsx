// components/chat/ThreadPane.tsx — tight iMessage-style timeline (grouping
// patterns from refs/akeru-bot MessagesTimeline.tsx, MIT), stripped of its
// store/state layer. Same props in/out as thread/Thread.tsx
// (turns/pending/conn/onRetry) plus the roster bots list for sender labels /
// mention chips. avatarSlot is still accepted but ignored (no in-chat
// avatars); the shell keeps passing it so App needs no change.
// Renders the pure mapper.turnToItems view-model list over a
// StickToBottom-style viewport: pinned follow while new content lands, an
// isAtBottom-gated jump pill, a thinking-dots activity row while the last
// turn streams, a retry row on failed turns, day-aware time dividers between
// turns that gap by more than 20 minutes, and centered system rows.
//
// Grouping: consecutive message bubbles from the same side (user/bot) whose
// timestamps land within GROUP_GAP_MS render as one visual group — 2px gaps
// inside the group, 10px between groups, and a single small muted
// right-aligned timestamp under agent groups (user groups carry none).
// Bubbles cap at 65% width: user groups right-align, bot groups left-align.
// The column itself is full-bleed (no avatars, edge-aligned text).
//
// Working state: while the tail turn streams the timeline shows ONLY the
// thinking-dots ActivityRow. The streaming caret, ThinkingRow output,
// StepMeter, and tool StatusCards stay out of the default path — ThinkingRow
// and StatusCard components (and their mapper branches) still render, but
// only when the turn errored or halted. Settled bubbles animate in with
// .msg-pop (user bubbles also .msg-pop-user).
//
// Windowing: past VIRTUALIZE_AFTER turns the timeline renders only the
// visible block slice plus 400px overscan (measured block heights, estimated
// until measured, spacers above/below). Short threads render whole, so
// existing pin behavior is untouched.
import { ArrowDown, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { RosterBot } from "../../lib/roster";
import type { ConnState, PendingPrompt, TurnViewState } from "../thread/types";
import type { AttachmentVM } from "../thread/viewModel";
import {
  turnToItems,
  type ChatItemVM,
  type SenderMessageBubbleVM,
  type SystemEventVM,
} from "./mapper";
import { ActivityRow } from "./ActivityRow";
import { ApprovalCard } from "./ApprovalCard";
import { DelegationCard } from "./DelegationCard";
import { InterBotDivider } from "./InterBotDivider";
import { Lightbox } from "./Lightbox";
import { MessageBubble } from "./MessageBubble";
import { StatusCard } from "./StatusCard";
import { ThinkingRow } from "./ThinkingRow";
import { UserInputCard } from "./UserInputCard";

/** Distance in px from the bottom that still counts as pinned. */
const PIN_THRESHOLD = 64;
/** Consecutive turns gap by more than this before a time divider renders. */
const DIVIDER_GAP_MS = 20 * 60_000;
/** Consecutive same-side bubbles gap by this (or less) to share one group. */
const GROUP_GAP_MS = 5 * 60_000;
/** Turn count past which the timeline windows to the visible slice. */
const VIRTUALIZE_AFTER = 20;
/** Rendered margin above/below the viewport while windowed. */
const OVERSCAN_PX = 400;
/** Height guess per block until measured (layout effect corrects it). */
const EST_BLOCK_PX = 120;

/**
 * Day-aware divider label (akeru formatDayAwareTimestamp pattern, local
 * calendar days): same-day "3:46 AM", "Yesterday 3:46 AM", else the
 * weekday plus time.
 */
function formatDividerTime(ts: number, nowMs: number): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25-hour days still count as whole days.
  const dayDiff = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `Yesterday ${time}`;
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  return `${weekday} ${time}`;
}

/** Group timestamp: short local time ("3:46 AM"). */
function formatGroupTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Aggregate raw turn reactions ({ emoji, by }[]) into the counted shape the
 * bubble reaction row renders ({ emoji, count, mine }). No identity info is
 * available in this track, so mine defaults to false.
 */
function aggregateReactions(raw: { emoji: string; by: string }[]): {
  emoji: string;
  count: number;
  mine: boolean;
}[] {
  const counts = new Map<string, number>();
  for (const reaction of raw) {
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
  }
  return [...counts].map(([emoji, count]) => ({ emoji, count, mine: false }));
}

/** True for the error path, where ThinkingRow/StatusCard rows stay visible. */
function isErrorPath(turn: TurnViewState): boolean {
  return turn.status === "error" || turn.halt !== null;
}

/** Null timestamps (still streaming) never split a group. */
function groupGapOk(prev: number | null, next: number | null): boolean {
  if (prev === null || next === null) return true;
  return Math.abs(next - prev) <= GROUP_GAP_MS;
}

const noopEdit = (_text: string): void => {};
const noopAnswer = (_id: string, _answer: string): void => {};
const noopDecision = (_id: string, _decision: "approved" | "rejected"): void => {};

interface GroupBubble {
  turn: TurnViewState;
  item: SenderMessageBubbleVM;
}

interface BubbleGroup {
  key: string;
  role: "user" | "bot";
  bubbles: GroupBubble[];
  /** Timestamp of the latest bubble; null while streaming. */
  ts: number | null;
}

interface TimelineBlock {
  key: string;
  node: ReactNode;
}

export function ThreadPane({
  turns,
  pending,
  conn,
  onRetry,
  avatarSlot = null,
  bots = [],
  playing = false,
  onEdit = noopEdit,
  onAnswer = noopAnswer,
  onDecision = noopDecision,
}: {
  turns: TurnViewState[];
  pending: PendingPrompt[];
  conn: ConnState;
  onRetry: (prompt: string) => void;
  /** Injected by the shell (BotAvatar); null renders the bare bubble. */
  avatarSlot?: ReactNode;
  /** Roster bots for sender labels, mention chips, and inter-bot dividers. */
  bots?: RosterBot[];
  playing?: boolean;
  /** Loads a user bubble's text back into the composer; default no-op. */
  onEdit?: (text: string) => void;
  /** Called with a user-input card's answer; default no-op (card marks answered locally). */
  onAnswer?: (id: string, answer: string) => void;
  /** Called with an approval card's decision; default no-op (card flips locally). */
  onDecision?: (id: string, decision: "approved" | "rejected") => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [lightbox, setLightbox] = useState<AttachmentVM | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const heightsRef = useRef(new Map<string, number>());
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [, setMeasTick] = useState(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD);
    setViewport({ top: el.scrollTop, height: el.clientHeight });
  }, []);

  // Shell bridge: the App header's scroll action dispatches this event.
  useEffect(() => {
    const onExternalScroll = () => {
      setAtBottom(true);
      scrollToBottom("smooth");
    };
    window.addEventListener("pi-do:scroll-bottom", onExternalScroll);
    return () => window.removeEventListener("pi-do:scroll-bottom", onExternalScroll);
  }, [scrollToBottom]);

  // Track viewport height (mount + resize) so the windowed slice is right
  // before the first scroll event fires.
  useEffect(() => {
    const sync = () => {
      const el = scrollRef.current;
      if (el !== null) setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  // Pinned follow: any re-render carrying fresh content (new turns, pending
  // rows, streaming deltas) pulls the viewport down while stuck. Runs on
  // mount too, so late-joining content starts at the bottom.
  useEffect(() => {
    if (atBottom) scrollToBottom("auto");
  });

  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const empty = turns.length === 0 && pending.length === 0 && !playing;

  const shared = { avatarSlot, bots, onEdit, onAnswer, onDecision, onRetry };

  // Flatten turns → timeline blocks. Consecutive same-side bubbles within
  // GROUP_GAP_MS merge into one BubbleGroup (even across turn boundaries);
  // every other item renders as its own block. ThinkingRow and tool
  // StatusCard rows only survive on the error path.
  const blocks: TimelineBlock[] = [];
  let group: BubbleGroup | null = null;
  const flushGroup = () => {
    if (group === null) return;
    const current = group;
    group = null;
    blocks.push({
      key: current.key,
      node: (
        <BubbleGroupView
          group={current}
          avatarSlot={avatarSlot}
          bots={bots}
          onOpenImage={setLightbox}
          onRetry={onRetry}
          onEdit={onEdit}
          onAnswer={onAnswer}
          onDecision={onDecision}
        />
      ),
    });
  };

  turns.forEach((turn, turnIndex) => {
    const ts = turn.startedAt ?? turn.endedAt;
    const prevTurn = turnIndex > 0 ? turns[turnIndex - 1] : null;
    const prevTs = prevTurn !== null ? (prevTurn.startedAt ?? prevTurn.endedAt) : null;
    const showDivider = ts !== null && prevTs !== null && ts - prevTs > DIVIDER_GAP_MS;
    const errorPath = isErrorPath(turn);
    if (showDivider && ts !== null) {
      flushGroup();
      blocks.push({
        key: `divider:${turn.runId}`,
        node: (
          <div
            data-testid="time-divider"
            className="flex items-center gap-3 py-1 text-xs text-[var(--muted-foreground)]"
            role="separator"
          >
            <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
            <span>{formatDividerTime(ts, Date.now())}</span>
            <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
          </div>
        ),
      });
    }
    for (const item of turnToItems(turn, bots)) {
      if ("kind" in item && item.kind === "thinking") {
        if (!errorPath) continue;
        flushGroup();
        blocks.push({
          key: `row:${item.id}`,
          node: <ChatItem item={item} {...shared} onOpenImage={setLightbox} retryText={turn.prompt} />,
        });
        continue;
      }
      if ("role" in item) {
        const bubble = item as SenderMessageBubbleVM;
        const bubbleTs = bubble.ts ?? turn.startedAt ?? turn.endedAt ?? null;
        if (group !== null && (group.role !== bubble.role || !groupGapOk(group.ts, bubbleTs))) {
          flushGroup();
        }
        if (group === null) {
          group = { key: `group:${bubble.id}`, role: bubble.role, bubbles: [], ts: null };
        }
        group.bubbles.push({ turn, item: bubble });
        group.ts = bubbleTs;
        continue;
      }
      // StatusCards (tool activity) only survive on the error path; every
      // other row (system, delegation, inter-bot, approval, user input,
      // error/halt cards) always renders.
      if ("rows" in item && !errorPath) continue;
      flushGroup();
      blocks.push({
        key: `row:${item.id}`,
        node: <ChatItem item={item} {...shared} onOpenImage={setLightbox} retryText={turn.prompt} />,
      });
    }
    if (turn.status === "error") {
      flushGroup();
      blocks.push({
        key: `retry:${turn.runId}`,
        node: (
          <div
            role="alert"
            className="flex items-center gap-2 px-1 text-sm text-[var(--muted-foreground)]"
          >
            <RotateCcw aria-hidden className="size-3.5 shrink-0" />
            <span>Turn failed.</span>
            <button
              type="button"
              data-testid={`retry-${turn.runId}`}
              onClick={() => onRetry(turn.prompt)}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
            >
              Retry
            </button>
          </div>
        ),
      });
    }
  });
  flushGroup();

  // Windowing math (block-level): offsets from measured heights (estimate
  // until measured), visible slice = viewport ± overscan.
  const windowing = turns.length > VIRTUALIZE_AFTER;
  const heights = heightsRef.current;
  const offsets: number[] = new Array(blocks.length);
  let cursor = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    offsets[i] = cursor;
    cursor += heights.get(blocks[i].key) ?? EST_BLOCK_PX;
  }
  let start = 0;
  let end = blocks.length;
  let topPad = 0;
  let bottomPad = 0;
  if (windowing) {
    const viewTop = viewport.top - OVERSCAN_PX;
    const viewBottom = viewport.top + viewport.height + OVERSCAN_PX;
    start = blocks.length;
    end = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      const h = heights.get(blocks[i].key) ?? EST_BLOCK_PX;
      if (offsets[i] + h >= viewTop && offsets[i] <= viewBottom) {
        if (i < start) start = i;
        if (i + 1 > end) end = i + 1;
      }
    }
    if (start > blocks.length - 1) {
      start = blocks.length - 1;
      end = blocks.length;
    }
    topPad = start > 0 ? offsets[start] : 0;
    const endOffset = end < blocks.length ? offsets[end] : cursor;
    bottomPad = cursor - endOffset;
  }

  // Measure rendered block nodes; estimates converge to real heights so the
  // spacers (and scroll position) stay stable.
  useLayoutEffect(() => {
    let changed = false;
    for (const [key, el] of nodeRefs.current) {
      if (!el.isConnected) continue;
      const h = el.offsetHeight;
      const prev = heights.get(key);
      if (prev === undefined || Math.abs(prev - h) > 2) {
        heights.set(key, h);
        changed = true;
      }
    }
    if (changed) setMeasTick((tick: number) => tick + 1);
  });

  const renderBlock = (block: TimelineBlock) => {
    if (!windowing) return <div key={block.key}>{block.node}</div>;
    return (
      <div
        key={block.key}
        ref={(el) => {
          if (el !== null) nodeRefs.current.set(block.key, el);
          else nodeRefs.current.delete(block.key);
        }}
      >
        {block.node}
      </div>
    );
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} data-testid="thread-viewport" className="h-full overflow-y-auto">
        <div className="flex w-full flex-col gap-[10px] px-6 py-4">
          {empty && (
            <p className="py-12 text-center text-sm text-[var(--muted-foreground)]">
              {conn === "connecting"
                ? "Connecting…"
                : "New session ready — send a prompt to start."}
            </p>
          )}
          {/* Fixture playback of a fresh session (fixture runIds, no live turn yet): blue NEW above the first group. */}
          {playing && blocks.length > 0 && turns.every((turn) => turn.runId.startsWith("fixture:")) && (
            <div
              data-testid="new-divider"
              className="flex items-center gap-3 py-1 text-xs font-medium text-[var(--info)]"
              role="separator"
              aria-label="New"
            >
              <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--info)]/40" />
              <span>NEW</span>
              <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--info)]/40" />
            </div>
          )}
          {windowing && topPad > 0 && <div aria-hidden style={{ height: topPad }} />}
          {windowing
            ? blocks.slice(start, end).map((block) => renderBlock(block))
            : blocks.map((block) => renderBlock(block))}
          {windowing && bottomPad > 0 && <div aria-hidden style={{ height: bottomPad }} />}
          {lastTurn?.status === "streaming" && <ActivityRow avatarSlot={avatarSlot} />}
          {pending.map((p) => (
            <div key={p.id} className="flex w-full justify-end">
              <div className="msg-pop msg-pop-user w-fit min-w-0 max-w-[65%]">
                <MessageBubble
                  vm={{ id: `pending:${p.id}`, role: "user", text: p.text, attachments: [], ts: null }}
                  bots={bots}
                  onOpenImage={setLightbox}
                  onRetry={onRetry}
                  retryText={p.text}
                  onEdit={onEdit}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          data-testid="scroll-to-bottom"
          aria-label="Scroll to bottom"
          onClick={() => {
            setAtBottom(true);
            scrollToBottom("smooth");
          }}
          className="absolute bottom-4 left-1/2 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] shadow-[var(--shadow-float)] transition-colors hover:text-[var(--foreground)]"
        >
          <ArrowDown aria-hidden className="size-4" />
        </button>
      )}
      {lightbox !== null && <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/**
 * One visual iMessage group: same-side bubbles at 2px gaps capped at 65%
 * width (right for the user, left for agents). Bot groups carry a single
 * small muted right-aligned timestamp under the group; user groups carry
 * no timestamp. Settled bubbles pop in (.msg-pop, plus .msg-pop-user for
 * the user side).
 */
function BubbleGroupView({
  group,
  avatarSlot,
  bots,
  onOpenImage,
  onRetry,
  onEdit,
  onAnswer,
  onDecision,
}: {
  group: BubbleGroup;
  avatarSlot: ReactNode;
  bots: RosterBot[];
  onOpenImage: (attachment: AttachmentVM) => void;
  onRetry: (prompt: string) => void;
  onEdit: (text: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onDecision: (id: string, decision: "approved" | "rejected") => void;
}) {
  const isUser = group.role === "user";
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} gap-[2px]`}>
      {group.bubbles.map(({ turn, item }, index) => {
        const settled = turn.status !== "streaming";
        const pop = settled ? (isUser ? "msg-pop msg-pop-user" : "msg-pop") : "";
        return (
          <div key={item.id} className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={`w-fit min-w-0 max-w-[65%] ${pop}`}>
              <ChatItem
                item={item}
                avatarSlot={!isUser && index === 0 ? avatarSlot : null}
                bots={bots}
                onOpenImage={onOpenImage}
                onRetry={onRetry}
                retryText={turn.prompt}
                onEdit={onEdit}
                onAnswer={onAnswer}
                onDecision={onDecision}
              />
            </div>
          </div>
        );
      })}
      {!isUser && group.ts !== null && (
        <div className="self-end px-1 text-[11px] leading-4 text-[var(--muted-foreground)]">
          {formatGroupTime(group.ts)}
        </div>
      )}
    </div>
  );
}

/** Discriminates the mapper-local rows, the (open) ThreadItemVM union. */
function ChatItem({
  item,
  avatarSlot,
  bots,
  onOpenImage,
  onRetry,
  retryText,
  onEdit,
  onAnswer,
  onDecision,
}: {
  item: ChatItemVM;
  avatarSlot: ReactNode;
  bots: RosterBot[];
  onOpenImage: (attachment: AttachmentVM) => void;
  onRetry: (prompt: string) => void;
  retryText: string;
  onEdit: (text: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onDecision: (id: string, decision: "approved" | "rejected") => void;
}) {
  if ("kind" in item) {
    if (item.kind === "system") return <SystemRow vm={item} />;
    if (item.kind === "thinking") return <ThinkingRow vm={item} />;
    if (item.kind === "delegation") return <DelegationCard vm={item} bots={bots} />;
    return <UserInputCard vm={item} onAnswer={onAnswer} />;
  }
  if ("role" in item) {
    const extra = item as SenderMessageBubbleVM;
    // Reply-track props (replyQuote/reactions) land on MessageBubble from
    // the sibling track; spread tolerantly so this compiles with or without
    // them. The streaming caret stays off — the ActivityRow is the only
    // working indicator in the default path.
    const replyProps = {
      ...(extra.replyTo !== undefined ? { replyQuote: extra.replyTo } : {}),
      ...(extra.reactions !== undefined ? { reactions: aggregateReactions(extra.reactions) } : {}),
    };
    const bubbleProps = {
      vm: item,
      avatarSlot,
      streaming: false,
      senderLabel: "senderLabel" in item ? item.senderLabel : undefined,
      bots,
      onOpenImage,
      onRetry,
      retryText: retryText.length > 0 ? retryText : undefined,
      onEdit,
      ...replyProps,
    };
    return <MessageBubble {...(bubbleProps as unknown as Parameters<typeof MessageBubble>[0])} />;
  }
  if ("rows" in item) return <StatusCard vm={item} />;
  if ("fromBotIds" in item) return <InterBotDivider vm={item} bots={bots} />;
  return <ApprovalCard vm={item} onDecide={onDecision} />;
}

/** Centered muted system row ("Created routine · Month-end close"). */
function SystemRow({ vm }: { vm: SystemEventVM }) {
  return (
    <div
      data-testid={`thread-item-${vm.id}`}
      className="flex items-center gap-3 py-0.5 text-xs text-[var(--muted-foreground)]"
      role="note"
    >
      <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
      <span className="max-w-[70%] truncate">{vm.text}</span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
    </div>
  );
}
