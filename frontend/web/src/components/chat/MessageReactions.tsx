// components/chat/MessageReactions.tsx — grouped reaction counts under the
// bubble (akeru MessageReactions pattern). Each pill shows emoji + count and
// toggles the caller's reaction; the pill reads active while mine is set.
export interface ReactionCount {
  emoji: string;
  count: number;
  mine: boolean;
}

/** Raw per-user reaction metadata as passed through on the bubble VM. */
export interface BubbleReaction {
  emoji: string;
  by: string;
}

/**
 * Collapse per-user reaction metadata into grouped counts. A pill reads mine
 * when any entry came from "me".
 */
export function groupReactions(list: readonly BubbleReaction[]): ReactionCount[] {
  const counts = new Map<string, ReactionCount>();
  for (const entry of list) {
    const existing = counts.get(entry.emoji);
    if (existing) {
      existing.count += 1;
      existing.mine = existing.mine || entry.by === "me";
    } else {
      counts.set(entry.emoji, { emoji: entry.emoji, count: 1, mine: entry.by === "me" });
    }
  }
  return Array.from(counts.values());
}

export function MessageReactions({
  messageId,
  reactions,
  onReact,
}: {
  messageId: string;
  reactions: readonly ReactionCount[];
  onReact?: (emoji: string) => void;
}) {
  if (reactions.length === 0) return null;
  return (
    <div data-testid={`message-reactions-${messageId}`} className="mt-1 flex flex-wrap gap-1">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          data-testid={`message-reaction-${messageId}-${reaction.emoji}`}
          aria-label={`React ${reaction.emoji}`}
          aria-pressed={reaction.mine}
          onClick={() => onReact?.(reaction.emoji)}
          className={[
            "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70",
            reaction.mine
              ? "border-[var(--primary)] bg-[var(--accent)] text-[var(--foreground)]"
              : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
          ].join(" ")}
        >
          <span aria-hidden>{reaction.emoji}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </button>
      ))}
    </div>
  );
}
