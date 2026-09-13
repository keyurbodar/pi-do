// components/chat/StatusCard.tsx — grouped tool-activity card: title +
// checklist rows (bold label, arrow, detail) + a Done pill. Row marks follow
// state: spinner while running, check when done, x when failed. Markup
// follows akeru's work-group rows (refs/akeru-bot, MIT) without their
// expansion/state layer.
import { Check, X } from "lucide-react";

import type { ItemState, StatusCardVM } from "../thread/viewModel";

export function StatusCard({ vm }: { vm: StatusCardVM }) {
  return (
    <div data-testid={`thread-item-${vm.id}`}>
      <div
        data-testid="status-card"
        className="w-fit max-w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{vm.title}</span>
          {vm.state === "running" && (
            <span
              aria-hidden
              className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--muted-foreground)] border-t-transparent"
            />
          )}
          {vm.state === "done" && (
            <span className="shrink-0 rounded-full bg-[var(--moss-tint)] px-2 py-0.5 text-xs font-medium text-[var(--success-foreground)]">
              Done
            </span>
          )}
          {vm.state === "failed" && (
            <span className="shrink-0 rounded-full bg-[var(--flag-tint)] px-2 py-0.5 text-xs font-medium text-[var(--destructive-foreground)]">
              Failed
            </span>
          )}
        </div>
        {vm.rows.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {vm.rows.map((row, index) => (
              <li key={`${row.label}:${index}`} className="flex min-w-0 items-center gap-2 text-sm">
                <RowMark state={row.state} />
                <span className="shrink-0 font-semibold">{row.label}</span>
                <span aria-hidden className="text-[var(--muted-foreground)]">
                  →
                </span>
                <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">
                  {row.detail ?? "…"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RowMark({ state }: { state: ItemState }) {
  if (state === "running") {
    return (
      <span
        aria-hidden
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--muted-foreground)] border-t-transparent"
      />
    );
  }
  if (state === "done") {
    return <Check aria-hidden className="size-3.5 shrink-0 text-[var(--success-foreground)]" />;
  }
  return <X aria-hidden className="size-3.5 shrink-0 text-[var(--destructive-foreground)]" />;
}
