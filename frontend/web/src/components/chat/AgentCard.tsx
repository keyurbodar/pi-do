// components/chat/AgentCard.tsx — clickable agent handoff card: avatar,
// name, task, and a status pill.
import type { ReactNode } from "react";

const statusClass: Record<string, string> = {
  running: "bg-[var(--accent)] text-[var(--foreground)]",
  done: "bg-[var(--moss-tint)] text-[var(--success-foreground)]",
  failed: "bg-[var(--flag-tint)] text-[var(--destructive-foreground)]",
};

export function AgentCard({
  avatar = null,
  name,
  task,
  status = "running",
  statusLabel,
  onOpen,
}: {
  avatar?: ReactNode;
  name: string;
  task: string;
  status?: "running" | "done" | "failed";
  statusLabel?: string;
  onOpen?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="agent-card"
      aria-label={`Open ${name}`}
      onClick={() => onOpen?.()}
      className="flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-left transition-colors hover:bg-[var(--accent)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
    >
      {avatar !== null && (
        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent)]">
          {avatar}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block max-w-[260px] truncate text-xs text-[var(--muted-foreground)]">
          {task}
        </span>
      </span>
      <span
        data-testid="agent-status"
        data-state={status}
        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusClass[status] ?? statusClass.running}`}
      >
        {statusLabel ?? status}
      </span>
    </button>
  );
}
