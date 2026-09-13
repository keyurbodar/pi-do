// components/chat/ApprovalCard.tsx — render-only approval card (title,
// description, state pill) following akeru's DelegationCard hairline style
// (refs/akeru-bot, MIT), stripped of its command layer. The mapper emits
// ApprovalVMs once turn metadata carries them; until then fixtures drive it.
import type { ApprovalVM } from "../thread/viewModel";

const STATE_PILL: Record<ApprovalVM["state"], string> = {
  pending: "bg-[var(--warning-surface)] text-[var(--warning-foreground)]",
  approved: "bg-[var(--moss-tint)] text-[var(--success-foreground)]",
  rejected: "bg-[var(--flag-tint)] text-[var(--destructive-foreground)]",
};

export function ApprovalCard({ vm }: { vm: ApprovalVM }) {
  return (
    <div data-testid={`thread-item-${vm.id}`}>
      <div
        data-testid="approval-card"
        className="ml-6 max-w-[min(42rem,calc(100%-2.5rem))] rounded-xl border border-[var(--border)] border-l-2 border-l-[var(--border)] bg-[var(--card)] px-3 py-2"
      >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{vm.title}</span>
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATE_PILL[vm.state]}`}
        >
          {vm.state}
        </span>
      </div>
      <p className="mt-1 text-sm leading-5 text-[var(--muted-foreground)]">{vm.description}</p>
      </div>
    </div>
  );
}
