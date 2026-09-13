// components/chat/MessageBubble.tsx — akeru UserTimelineRow /
// AssistantTimelineRow markup (refs/akeru-bot, MIT), stripped of their state
// layer: no copy buttons, no reactions, no revert. User bubbles right-align
// on --message-surface; bot bubbles sit left with an avatar slot the shell
// fills (BotAvatar) later. Image attachments render as a clickable grid that
// opens the lightbox.
import { FileText } from "lucide-react";
import type { ReactNode } from "react";

import type { AttachmentVM, MessageBubbleVM } from "../thread/viewModel";
import { ChatMarkdown } from "./ChatMarkdown";

export function MessageBubble({
  vm,
  avatarSlot = null,
  streaming = false,
  onOpenImage,
}: {
  vm: MessageBubbleVM;
  avatarSlot?: ReactNode;
  /** True while this bubble is the live tail of a streaming turn. */
  streaming?: boolean;
  onOpenImage: (attachment: AttachmentVM) => void;
}) {
  if (vm.role === "user") {
    return (
      <div data-testid={`thread-item-${vm.id}`} className="group flex flex-col items-end">
        <div className="max-w-[80%] rounded-2xl bg-[var(--message-surface)] px-3.5 py-2.5 text-[var(--message-foreground)]">
          {vm.text.length > 0 && <ChatMarkdown text={vm.text} />}
          <AttachmentGrid attachments={vm.attachments} onOpen={onOpenImage} />
        </div>
      </div>
    );
  }

  return (
    <div data-testid={`thread-item-${vm.id}`} className="flex min-w-0 items-start gap-2 px-1 py-0.5">
      {avatarSlot !== null && <div className="mt-0.5 shrink-0">{avatarSlot}</div>}
      <div className="min-w-0 flex-1">
        {vm.text.length > 0 && (
          <div className="flex items-start gap-0.5">
            <div className="min-w-0 flex-1">
              <ChatMarkdown text={vm.text} />
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
