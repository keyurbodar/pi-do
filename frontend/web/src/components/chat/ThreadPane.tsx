// components/chat/ThreadPane.tsx — akeru-style timeline (refs/akeru-bot
// MessagesTimeline.tsx, MIT), stripped of its store/state layer. Same props
// in/out as thread/Thread.tsx (turns/pending/conn/onRetry) plus an optional
// avatarSlot the shell fills with BotAvatar and the roster bots list for
// sender labels / mention chips. Renders the pure mapper.turnToItems
// view-model list over a StickToBottom-style viewport: pinned follow while
// new content lands, an isAtBottom-gated jump pill, a shimmer activity row
// while the last turn streams, a retry row on failed turns, day-aware time
// dividers between turns that gap by more than 20 minutes, and centered
// system rows.
import { ArrowDown, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { RosterBot } from "../../lib/roster";
import type { ConnState, PendingPrompt, TurnViewState } from "../thread/types";
import type { AttachmentVM } from "../thread/viewModel";
import { ActivityRow } from "./ActivityRow";
import { ApprovalCard } from "./ApprovalCard";
import { InterBotDivider } from "./InterBotDivider";
import { Lightbox } from "./Lightbox";
import { turnToItems, type ChatItemVM, type SenderMessageBubbleVM, type SystemEventVM } from "./mapper";
import { MessageBubble } from "./MessageBubble";
import { StatusCard } from "./StatusCard";
import { ThinkingRow } from "./ThinkingRow";

/** Distance in px from the bottom that still counts as pinned. */
const PIN_THRESHOLD = 64;
/** Consecutive turns gap by more than this before a time divider renders. */
const DIVIDER_GAP_MS = 20 * 60_000;

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

export function ThreadPane({
  turns,
  pending,
  conn,
  onRetry,
  avatarSlot = null,
  bots = [],
  playing = false,
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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [lightbox, setLightbox] = useState<AttachmentVM | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD);
  }, []);

  // Pinned follow: any re-render carrying fresh content (new turns, pending
  // rows, streaming deltas) pulls the viewport down while stuck. Runs on
  // mount too, so late-joining content starts at the bottom.
  useEffect(() => {
    if (atBottom) scrollToBottom("auto");
  });

  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const empty = turns.length === 0 && pending.length === 0 && !playing;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-3 px-4 py-4">
          {empty && (
            <p className="py-12 text-center text-sm text-[var(--muted-foreground)]">
              {conn === "connecting"
                ? "Connecting…"
                : "New session ready — send a prompt to start."}
            </p>
          )}
          {turns.map((turn, turnIndex) => {
            const items = turnToItems(turn, bots);
            const ts = turn.startedAt ?? turn.endedAt;
            const prevTurn = turnIndex > 0 ? turns[turnIndex - 1] : null;
            const prevTs = prevTurn !== null ? (prevTurn.startedAt ?? prevTurn.endedAt) : null;
            const showDivider = ts !== null && prevTs !== null && ts - prevTs > DIVIDER_GAP_MS;
            return (
              <div key={turn.runId} className="flex flex-col gap-2">
                {showDivider && (
                  <div
                    data-testid="time-divider"
                    className="flex items-center gap-3 py-1 text-xs text-[var(--muted-foreground)]"
                    role="separator"
                  >
                    <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
                    <span>{formatDividerTime(ts, Date.now())}</span>
                    <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
                  </div>
                )}
                {items.map((item, index) => (
                  <ChatItem
                    key={item.id}
                    item={item}
                    streaming={turn.status === "streaming" && index === items.length - 1}
                    avatarSlot={avatarSlot}
                    bots={bots}
                    onOpenImage={setLightbox}
                  />
                ))}
                {turn.status === "error" && (
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
                )}
              </div>
            );
          })}
          {pending.map((p) => (
            <MessageBubble
              key={p.id}
              vm={{ id: `pending:${p.id}`, role: "user", text: p.text, attachments: [], ts: null }}
              bots={bots}
              onOpenImage={setLightbox}
            />
          ))}
          {(conn === "open" || lastTurn?.live === false) && lastTurn?.status === "streaming" && (
            <ActivityRow avatarSlot={avatarSlot} />
          )}
          {conn === "closed" && !empty && (
            <p className="px-1 text-sm text-[var(--muted-foreground)]">
              Live stream closed — Retry re-queues the prompt over a fresh socket.
            </p>
          )}
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

/** Discriminates the mapper-local rows, the (open) ThreadItemVM union. */
function ChatItem({
  item,
  streaming,
  avatarSlot,
  bots,
  onOpenImage,
}: {
  item: ChatItemVM;
  streaming: boolean;
  avatarSlot: ReactNode;
  bots: RosterBot[];
  onOpenImage: (attachment: AttachmentVM) => void;
}) {
  if ("kind" in item) {
    if (item.kind === "system") return <SystemRow vm={item} />;
    return <ThinkingRow vm={item} />;
  }
  if ("role" in item)
    return (
      <MessageBubble
        vm={item}
        avatarSlot={avatarSlot}
        streaming={streaming}
        senderLabel={"senderLabel" in item ? (item as SenderMessageBubbleVM).senderLabel : undefined}
        bots={bots}
        onOpenImage={onOpenImage}
      />
    );
  if ("rows" in item) return <StatusCard vm={item} />;
  if ("fromBotIds" in item) return <InterBotDivider vm={item} bots={bots} />;
  return <ApprovalCard vm={item} />;
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
