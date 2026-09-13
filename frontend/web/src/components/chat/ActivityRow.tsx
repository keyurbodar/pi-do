// components/chat/ActivityRow.tsx — working row shown while the tail turn
// streams. Pairs the responsible bot's avatar (resolved upstream from
// turn.senderId, shell active-bot slot as fallback) with the three bouncing
// dots: the avatar wears a theme-shimmer sheen sweep (existing
// animate-shimmer, no new animation files) while the turn works, and the
// whole row unmounts the moment the turn settles — settled bubbles stay
// avatar-free, and error/halted turns render the retry row instead, so no
// orphan avatar survives failure.
import type { ReactNode } from "react";

const DOT_DELAYS = ["0ms", "150ms", "300ms"];

export function ActivityRow({ avatarSlot = null }: { avatarSlot?: ReactNode }) {
  return (
    <div
      aria-live="polite"
      data-testid="activity-row"
      className="flex w-full items-center justify-start text-sm"
    >
      <div className="flex w-fit min-w-0 max-w-[65%] items-center gap-2.5 py-1">
        {avatarSlot !== null && (
          <span data-testid="activity-avatar" aria-hidden className="relative inline-flex shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
            {avatarSlot}
            <span className="pointer-events-none absolute inset-0 animate-shimmer rounded-full bg-[linear-gradient(100deg,transparent_40%,color-mix(in_srgb,var(--foreground)_14%,transparent)_50%,transparent_60%)] bg-[length:200%_100%]" />
          </span>
        )}
        <span className="flex min-h-8 items-center gap-1.5" aria-hidden>
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
    </div>
  );
}
