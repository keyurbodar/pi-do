// components/chat/ActivityRow.tsx — thinking-dots row shown while the tail
// turn streams. The shell injects the avatar; three bouncing dots are the
// only working indicator in the default path (no step meter, no streaming
// caret, no ThinkingRow output, no tool StatusCards — those render only for
// error/halted turns).
import type { ReactNode } from "react";

const DOT_DELAYS = ["0ms", "150ms", "300ms"];

export function ActivityRow({ avatarSlot = null }: { avatarSlot?: ReactNode }) {
  return (
    <div
      aria-live="polite"
      data-testid="activity-row"
      className="flex min-h-8 items-center gap-3 px-2 py-1 text-sm"
    >
      {avatarSlot !== null && <div className="flex size-8 shrink-0 items-center justify-center">{avatarSlot}</div>}
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
