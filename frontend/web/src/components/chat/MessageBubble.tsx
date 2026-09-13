// components/chat/MessageBubble.tsx — akeru UserTimelineRow /
// AssistantTimelineRow markup (refs/akeru-bot, MIT), stripped of their state
// layer. User bubbles right-align on --message-surface; bot bubbles sit left
// with an avatar slot the shell fills (BotAvatar) later. Image attachments
// render as a clickable grid that opens the lightbox. Group threads add a
// muted sender label above the bubble, and text that names a roster bot
// renders that run as an inline BotMention chip instead of markdown. Every
// bubble carries a hover toolbar: copy-to-clipboard with Copied feedback,
// retry (re-sends via onRetry), and — on user bubbles — edit, which loads
// the text back into the composer via onEdit (default no-op).
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import type { RosterBot } from "../../lib/roster";
import type { AttachmentVM, MessageBubbleVM } from "../thread/viewModel";
import { BotMention } from "./BotMention";
import { ChatMarkdown } from "./ChatMarkdown";

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
  /** Re-sends text (the shell passes the turn prompt as retryText). */
  onRetry?: (prompt: string) => void;
  /** Loads a user bubble's text back into the composer; default no-op. */
  onEdit?: (text: string) => void;
  /** Prompt re-sent by the retry action; defaults to the bubble text. */
  retryText?: string;
}) {
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

  const toolbar = (
    <div
      data-testid={`message-actions-${vm.id}`}
      className="absolute -top-3 right-1 z-10 flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--card)] p-0.5 opacity-0 shadow-[var(--shadow-float)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100"
    >
      <button
        type="button"
        data-testid={`message-copy-${vm.id}`}
        aria-label="Copy message"
        title="Copy message"
        onClick={copy}
        className="flex size-6 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
      >
        {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
      <button
        type="button"
        data-testid={`message-retry-${vm.id}`}
        aria-label="Retry prompt"
        title="Retry prompt"
        onClick={() => onRetry?.(retryText ?? vm.text)}
        className="flex size-6 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
      >
        <RotateCcw aria-hidden className="size-3.5" />
      </button>
      {vm.role === "user" && (
        <button
          type="button"
          data-testid={`message-edit-${vm.id}`}
          aria-label="Edit in composer"
          title="Edit in composer"
          onClick={() => onEdit?.(vm.text)}
          className="flex size-6 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
        >
          <Pencil aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );

  if (vm.role === "user") {
    return (
      <div data-testid={`thread-item-${vm.id}`} className="group relative flex flex-col items-end">
        {toolbar}
        <div className="max-w-[80%] rounded-2xl bg-[var(--message-surface)] px-3.5 py-2.5 text-[var(--message-foreground)]">
          {renderText(vm.text, bots)}
          <AttachmentGrid attachments={vm.attachments} onOpen={onOpenImage} />
        </div>
        {copied && (
          <span data-testid={`message-copied-${vm.id}`} className="px-1 text-xs text-[var(--muted-foreground)]">
            Copied
          </span>
        )}
      </div>
    );
  }

  return (
    <div data-testid={`thread-item-${vm.id}`} className="group relative flex min-w-0 items-start gap-3 px-2 py-1">
      {avatarSlot !== null && <div className="flex size-8 shrink-0 items-center justify-center">{avatarSlot}</div>}
      {toolbar}
      <div className="min-w-0 flex-1">
        {senderLabel !== undefined && (
          <div className="px-0.5 pb-0.5 text-xs text-[var(--muted-foreground)]">{senderLabel}</div>
        )}
        {vm.text.length > 0 && (
          <div className="flex items-start gap-0.5">
            <div className="min-w-0 flex-1">
              {renderText(vm.text, bots)}
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
