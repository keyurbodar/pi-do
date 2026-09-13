// components/chat/ThreadPane.tsx — akeru-style timeline (refs/akeru-bot
// MessagesTimeline.tsx, MIT), stripped of its store/state layer. Same props
// in/out as thread/Thread.tsx (turns/pending/conn/onRetry) plus an optional
// avatarSlot the shell fills with BotAvatar. Renders the pure
// mapper.turnToItems view-model list over a StickToBottom-style viewport:
// pinned follow while new content lands, an isAtBottom-gated jump pill, a
// shimmer activity row while the last turn streams, and a retry row on
// failed turns.
import { ArrowDown, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ConnState, PendingPrompt, TurnViewState } from "../thread/types";
import type { AttachmentVM } from "../thread/viewModel";
import { ActivityRow } from "./ActivityRow";
import { ApprovalCard } from "./ApprovalCard";
import { InterBotDivider } from "./InterBotDivider";
import { Lightbox } from "./Lightbox";
import { turnToItems, type ChatItemVM } from "./mapper";
import { MessageBubble } from "./MessageBubble";
import { StatusCard } from "./StatusCard";
import { ThinkingRow } from "./ThinkingRow";

/** Distance in px from the bottom that still counts as pinned. */
const PIN_THRESHOLD = 64;

export function ThreadPane({
  turns,
  pending,
  conn,
  onRetry,
  avatarSlot = null,
  playing = false,
}: {
  turns: TurnViewState[];
  pending: PendingPrompt[];
  conn: ConnState;
  onRetry: (prompt: string) => void;
  /** Injected by the shell (BotAvatar); null renders the bare bubble. */
  avatarSlot?: ReactNode;
  /** True while a scripted fixture conversation is mid-playback; suppresses the empty-state prompt. */
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
          {turns.map((turn) => {
            const items = turnToItems(turn);
            return (
              <div key={turn.runId} className="flex flex-col gap-2">
                {items.map((item, index) => (
                  <ChatItem
                    key={item.id}
                    item={item}
                    streaming={turn.status === "streaming" && index === items.length - 1}
                    avatarSlot={avatarSlot}
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

/** Discriminates the (open) ThreadItemVM union + mapper-local ThinkingRowVM. */
function ChatItem({
  item,
  streaming,
  avatarSlot,
  onOpenImage,
}: {
  item: ChatItemVM;
  streaming: boolean;
  avatarSlot: ReactNode;
  onOpenImage: (attachment: AttachmentVM) => void;
}) {
  if ("kind" in item) return <ThinkingRow vm={item} />;
  if ("role" in item)
    return (
      <MessageBubble vm={item} avatarSlot={avatarSlot} streaming={streaming} onOpenImage={onOpenImage} />
    );
  if ("rows" in item) return <StatusCard vm={item} />;
  if ("fromBotIds" in item) return <InterBotDivider vm={item} />;
  return <ApprovalCard vm={item} />;
}
