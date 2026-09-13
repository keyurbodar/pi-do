// components/chat/ActivityRow.tsx — thinking-dots row shown while the tail
// turn streams. avatarSlot is accepted-but-ignored (no in-chat avatars);
// three bouncing dots are the only working indicator in the default path
// (no step meter, no streaming caret, no ThinkingRow output, no tool
// StatusCards — those render only for error/halted turns).
import type { ReactNode } from "react";

const DOT_DELAYS = ["0ms", "150ms", "300ms"];

export function ActivityRow({ avatarSlot = null }: { avatarSlot?: ReactNode }) {
  void avatarSlot;
  return (
    <div
      aria-live="polite"
      data-testid="activity-row"
      className="flex min-h-8 items-center py-1 text-sm"
    >
      <span className="flex items-center gap-1.5" aria-hidden>
        {DOT_DELAYS.map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-bounce rounded-full bg-[var(--muted-foreground)]"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
      <span className="sr-only">Thinking…</span>
    </div>
  );
}
