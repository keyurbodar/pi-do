// components/chat/MessageBubble.tsx — akeru UserTimelineRow /
// AssistantTimelineRow markup (refs/akeru-bot, MIT), stripped of their state
// layer: no copy buttons, no reactions, no revert. User bubbles right-align
// on --message-surface; bot bubbles sit left with an avatar slot the shell
// fills (BotAvatar) later. Image attachments render as a clickable grid that
// opens the lightbox. Group threads add a muted sender label above the
// bubble, and text that names a roster bot renders that run as an inline
// BotMention chip instead of markdown.
import { FileText } from "lucide-react";
import type { ReactNode } from "react";

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
}) {
  if (vm.role === "user") {
    return (
      <div data-testid={`thread-item-${vm.id}`} className="group flex flex-col items-end">
        <div className="max-w-[80%] rounded-2xl bg-[var(--message-surface)] px-3.5 py-2.5 text-[var(--message-foreground)]">
          {renderText(vm.text, bots)}
          <AttachmentGrid attachments={vm.attachments} onOpen={onOpenImage} />
        </div>
      </div>
    );
  }

  return (
    <div data-testid={`thread-item-${vm.id}`} className="flex min-w-0 items-start gap-3 px-2 py-1">
      {avatarSlot !== null && <div className="flex size-8 shrink-0 items-center justify-center">{avatarSlot}</div>}
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
