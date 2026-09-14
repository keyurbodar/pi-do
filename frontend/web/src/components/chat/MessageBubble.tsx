// components/chat/MessageBubble.tsx — akeru UserTimelineRow /
// AssistantTimelineRow markup (refs/akeru-bot, MIT), stripped of their state
// layer. User bubbles right-align on --message-surface; bot bubbles sit left
// with no avatar column — avatarSlot is accepted-but-ignored. Image
// render as a clickable grid that opens the lightbox. Group threads add a
// muted sender label above the bubble, and text that names a roster bot
// renders that run as an inline BotMention chip instead of markdown. Every
// bubble carries a hover toolbar (react / reply / more with copy +
// download-transcript-bit), an optional quoted reply block above its text,
// and grouped reaction counts below it. Reaction state is local per message
// id; callers may observe picks via onReact. Legacy onRetry/onEdit/retryText
// props are accepted but no longer rendered — retry/revert/edit affordances
// were removed in favor of reply-everywhere.
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import type { RosterBot } from "../../lib/roster";
import type { AttachmentVM, MessageBubbleVM } from "../thread/viewModel";
import { BotMention } from "./BotMention";
import { ChatMarkdown } from "./ChatMarkdown";
import { MessageControls } from "./MessageControls";
import { groupReactions, MessageReactions, type ReactionCount } from "./MessageReactions";
import { setReplyTarget } from "./replyStore";

/** Quoted reply block rendered above the bubble text. */
export interface ReplyQuote {
  label: string;
  text: string;
}

/** Mapper-local bubble extras passed straight from turn metadata. */
interface BubbleExtras {
  replyTo?: ReplyQuote;
  reactions?: { emoji: string; by: string }[];
}

export function MessageBubble({
  vm,
  avatarSlot = null,
  streaming = false,
  senderLabel,
  bots = [],
  onOpenImage,
  onRetry,
  onEdit,
  retryText,
  onAnswer,
  onDecision,
  replyQuote,
  reactions,
  onReact,
  onReply,
}: {
  vm: MessageBubbleVM;
  avatarSlot?: ReactNode;
  /** True while this bubble is the live tail of a streaming turn. */
  streaming?: boolean;
  /** Sender name shown above the bubble in multi-sender (group) threads. */
  senderLabel?: string;
  /** Roster bots resolvable as inline mentions; empty disables chip rendering. */
  bots?: RosterBot[];
  onOpenImage: (attachment: AttachmentVM) => void;
  /** Legacy: accepted for frozen callers, no longer rendered. */
  onRetry?: (prompt: string) => void;
  /** Legacy: accepted for frozen callers, no longer rendered. */
  onEdit?: (text: string) => void;
  /** Legacy: accepted for frozen callers, no longer rendered. */
  retryText?: string;
  /** Legacy: accepted for frozen callers, no longer rendered. */
  onAnswer?: (id: string, answer: string) => void;
  /** Legacy: accepted for frozen callers, no longer rendered. */
  onDecision?: (id: string, decision: "approved" | "rejected") => void;
  /** Nested quoted block above the text; defaults to the VM replyTo extra. */
  replyQuote?: ReplyQuote | null;
  /** Grouped reaction counts; defaults to the grouped VM reactions extra. */
  reactions?: ReactionCount[];
  /** Called with the picked emoji; default updates local-only state. */
  onReact?: (emoji: string) => void;
  /** Arms the composer reply strip; default targets this bubble's text. */
  onReply?: () => void;
}) {
  // avatarSlot renders nothing (no in-chat avatars); accepted so the shell
  // keeps compiling without changes. Legacy props likewise stay accepted.
  void avatarSlot;
  void onRetry;
  void onEdit;
  void retryText;
  void onAnswer;
  void onDecision;

  const extras = vm as MessageBubbleVM & BubbleExtras;
  const quote: ReplyQuote | null =
    replyQuote !== undefined ? replyQuote : (extras.replyTo ?? null);

  const baseReactions: ReactionCount[] =
    reactions ?? groupReactions(extras.reactions ?? []);

  // Local reaction state, keyed by message id so id reuse never leaks picks.
  const [reactionState, setReactionState] = useState<{
    forId: string;
    counts: ReactionCount[];
  }>(() => ({ forId: vm.id, counts: baseReactions }));
  if (reactionState.forId !== vm.id) {
    setReactionState({ forId: vm.id, counts: baseReactions });
  }
  const visibleReactions =
    reactionState.forId === vm.id ? reactionState.counts : baseReactions;

  const react = (emoji: string) => {
    setReactionState((prev) => {
      const counts = prev.forId === vm.id ? prev.counts : baseReactions;
      const existing = counts.find((entry) => entry.emoji === emoji);
      const next: ReactionCount[] =
        existing !== undefined
          ? counts.map((entry) =>
              entry.emoji === emoji
                ? {
                    emoji: entry.emoji,
                    count: entry.mine ? Math.max(0, entry.count - 1) : entry.count + 1,
                    mine: !entry.mine,
                  }
                : entry,
            ).filter((entry) => entry.count > 0)
          : [...counts, { emoji, count: 1, mine: true }];
      return { forId: vm.id, counts: next };
    });
    onReact?.(emoji);
  };

  const replyLabel = senderLabel ?? (vm.role === "user" ? "You" : "Bot");
  const reply = () => {
    if (onReply !== undefined) {
      onReply();
      return;
    }
    setReplyTarget({ label: replyLabel, text: vm.text.slice(0, 120) });
  };

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(vm.text);
    } catch {
      // Clipboard API unavailable (permissions, insecure context): fall
      // back to a transient textarea + execCommand.
      try {
        const area = document.createElement("textarea");
        area.value = vm.text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch {
        return;
      }
    }
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const downloadTranscript = () => {
    const blob = new Blob([`${replyLabel}: ${vm.text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `message-${vm.id}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const toolbar = (
    <MessageControls
      messageId={vm.id}
      onReact={react}
      onReply={reply}
      onCopy={() => void copy()}
      copied={copied}
      onDownloadTranscript={downloadTranscript}
    />
  );

  const quoteBlock =
    quote !== null ? (
      <div
        data-testid={`message-reply-quote-${vm.id}`}
        className="mb-1.5 rounded-md border-l-2 border-[var(--primary)] bg-black/5 px-2 py-1 text-xs dark:bg-white/10"
      >
        <p className="font-medium">{quote.label}</p>
        <p className="truncate opacity-70">{quote.text}</p>
      </div>
    ) : null;

  if (vm.role === "user") {
    return (
      <div data-testid={`thread-item-${vm.id}`} className="group relative flex flex-col items-end">
        <div className="relative w-fit max-w-[80%] rounded-2xl bg-[var(--message-surface)] px-3.5 py-2 text-[15px] leading-6 text-[var(--message-foreground)]">
          {toolbar}
          {quoteBlock}
          <div className="[&>div]:text-[15px] [&>div]:leading-6 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul:first-child]:mt-0 [&_ul:last-child]:mb-0 [&_ol:first-child]:mt-0 [&_ol:last-child]:mb-0 [&_pre:first-child]:mt-0 [&_pre:last-child]:mb-0 [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0">
            {/* Own text renders verbatim: never chip a bot name here (a message
                like "hi" to a bot named hi must stay text, not a squeezed chip). */}
            {renderText(vm.text, [])}
          </div>
          <AttachmentGrid attachments={vm.attachments} onOpen={onOpenImage} />
        </div>
        <MessageReactions messageId={vm.id} reactions={visibleReactions} onReact={react} />
        {copied && (
          <span data-testid={`message-copied-${vm.id}`} className="px-1 text-xs text-[var(--muted-foreground)]">
            Copied
          </span>
        )}
      </div>
    );
  }

  return (
    <div data-testid={`thread-item-${vm.id}`} className="group relative flex min-w-0 items-start py-1">
      <div className="min-w-0 flex-1">
        {vm.text.length === 0 && toolbar}
        {senderLabel !== undefined && (
          <div className="px-0.5 pb-0.5 text-xs text-[var(--muted-foreground)]">{senderLabel}</div>
        )}
        {vm.text.length > 0 && (
          <div className="flex items-start gap-0.5">
            <div className="min-w-0 flex-1">
              {quoteBlock}
              <div className="relative w-fit max-w-[75%] rounded-2xl bg-white/[0.06] px-3.5 py-2 text-[15px] leading-[1.55] [&>div]:text-[15px] [&>div]:leading-[1.55] [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul:first-child]:mt-0 [&_ul:last-child]:mb-0 [&_ol:first-child]:mt-0 [&_ol:last-child]:mb-0 [&_pre:first-child]:mt-0 [&_pre:last-child]:mb-0 [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0">
                {toolbar}
                {renderText(vm.text, bots)}
              </div>
            </div>
            {streaming && (
              <span
                aria-hidden
                className="mt-1 inline-block h-4 w-[2px] shrink-0 animate-blink bg-[var(--foreground)]"
              />
            )}
          </div>
        )}
        <AttachmentGrid attachments={vm.attachments} onOpen={onOpenImage} />
        <MessageReactions messageId={vm.id} reactions={visibleReactions} onReact={react} />
        {copied && (
          <span data-testid={`message-copied-${vm.id}`} className="text-xs text-[var(--muted-foreground)]">
            Copied
          </span>
        )}
      </div>
    </div>
  );
}

/** One segment of bubble text: a plain run or an inline bot mention. */
type TextSegment = { kind: "text"; text: string } | { kind: "mention"; bot: RosterBot };

/**
 * Split bubble text on roster bot names (case-insensitive, whole-word).
 * Returns null when no bot is named so the caller keeps markdown rendering —
 * mention-bearing text renders as plain runs + BotMention chips instead.
 */
function splitMentions(text: string, bots: RosterBot[]): TextSegment[] | null {
  // A message that IS just a name ("hi", "Hi!") is a greeting, not a
  // reference — never chip it, on either side.
  const bare = text.trim().toLowerCase().replace(/[!.,?]+$/, "");
  if (bots.some((b) => b.name.toLowerCase() === bare)) return null;
  if (bots.length === 0) return null;
  const escaped = bots
    .map((b) => b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  const pattern = new RegExp(`\\b(${escaped})\\b`, "gi");
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;
    if (index > cursor) segments.push({ kind: "text", text: text.slice(cursor, index) });
    const bot = bots.find((b) => b.name.toLowerCase() === match[0].toLowerCase());
    if (bot) segments.push({ kind: "mention", bot });
    cursor = index + match[0].length;
  }
  if (segments.length === 0) return null;
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** Mention-bearing text renders runs + chips; mention-free text keeps markdown. */
function renderText(text: string, bots: RosterBot[]): ReactNode {
  const segments = splitMentions(text, bots);
  if (segments === null) return <ChatMarkdown text={text} />;
  return (
    <div className="text-sm leading-relaxed">
      {segments.map((segment, i) =>
        segment.kind === "mention" ? (
          <BotMention key={i} bot={segment.bot} />
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </div>
  );
}

/** Image grid under the bubble text (akeru MessageImageAttachments pattern). */
function AttachmentGrid({
  attachments,
  onOpen,
}: {
  attachments: AttachmentVM[];
  onOpen: (attachment: AttachmentVM) => void;
}) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");

  return (
    <div className="mt-2">
      {images.length > 0 && (
        <div className="grid max-w-[420px] grid-cols-2 gap-2">
          {images.map((image) => (
            <div
              key={image.id}
              className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)]/70"
            >
              <button
                type="button"
                data-testid={`attachment-${image.id}`}
                aria-label={`Preview ${image.name}`}
                onClick={() => onOpen(image)}
                className="h-full w-full cursor-zoom-in"
              >
                <img
                  src={image.url}
                  alt={image.name}
                  className="block h-auto max-h-[220px] w-full object-cover"
                />
              </button>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((file) => (
            <span
              key={file.id}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted-foreground)]"
            >
              <FileText aria-hidden className="size-3.5 shrink-0" />
              <span className="max-w-[220px] truncate">{file.name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
