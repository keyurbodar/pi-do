// components/chat/ChatHeader.tsx — full chat header content (akeru
// ActiveBotHeaderChip pattern, refs/akeru-bot, MIT, stripped of its store
// layer): avatar, name, and presence text. The shell (App) owns placement
// and fills the avatar slot.
import type { ReactNode } from "react";

export function ChatHeader({
  name,
  presenceText,
  avatar = null,
}: {
  name: string;
  presenceText: string;
  avatar?: ReactNode;
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
    </div>
  );
}
