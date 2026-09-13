// components/chat/ChatHeader.tsx — full chat header content (akeru
// ActiveBotHeaderChip pattern, refs/akeru-bot, MIT, stripped of its store
// layer): avatar, name, presence text, and thread actions (scroll-to-bottom,
// copy-transcript, new-turn). The shell (App) owns placement and fills the
// avatar slot; actions arrive as callbacks so the shell can bridge them to
// the timeline (scroll event) and the session view (transcript, clear).
import type { ReactNode } from "react";
import { ArrowDown, Copy, PenLine } from "lucide-react";

export function ChatHeader({
  name,
  presenceText,
  avatar = null,
  copied = false,
  onScrollBottom,
  onCopyTranscript,
  onNewTurn,
}: {
  name: string;
  presenceText: string;
  avatar?: ReactNode;
  /** True briefly after the transcript lands on the clipboard. */
  copied?: boolean;
  onScrollBottom: () => void;
  onCopyTranscript: () => void;
  onNewTurn: () => void;
}) {
  return (
    <div data-testid="chat-header" className="flex min-w-0 flex-1 items-center gap-2">
      {avatar !== null && (
        <span data-testid="header-avatar" className="flex shrink-0 items-center">
          {avatar}
        </span>
      )}
      <span className="min-w-0 truncate text-sm font-semibold text-foreground">{name}</span>
      <span data-testid="header-presence" className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {presenceText}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="header-scroll-bottom"
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          onClick={onScrollBottom}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <ArrowDown aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          data-testid="header-copy-transcript"
          aria-label="Copy transcript"
          title="Copy transcript"
          onClick={onCopyTranscript}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <Copy aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          data-testid="header-new-turn"
          aria-label="Start new turn view"
          title="Clear the live turns view"
          onClick={onNewTurn}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <PenLine aria-hidden className="size-4" />
        </button>
        {copied && (
          <span data-testid="header-copied" className="shrink-0 text-xs text-muted-foreground">
            Copied
          </span>
        )}
      </span>
    </div>
  );
}
