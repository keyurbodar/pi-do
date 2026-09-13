// components/chat/ApprovalCard.tsx — approval card (akeru DelegationCard
// hairline style, refs/akeru-bot, MIT): title, description, state pill, plus
// Approve / Reject actions while pending. Deciding runs the local
// useApprovalDecision state machine (no backend): the card flips to its
// decided state, appends the decided marker, and the fixture script keeps
// playing underneath.
import { Check, X } from "lucide-react";

import type { ApprovalVM } from "../thread/viewModel";
import { useApprovalDecision } from "./useApprovalDecision";

const STATE_PILL: Record<ApprovalVM["state"], string> = {
  pending: "bg-[var(--warning-surface)] text-[var(--warning-foreground)]",
  approved: "bg-[var(--moss-tint)] text-[var(--success-foreground)]",
  rejected: "bg-[var(--flag-tint)] text-[var(--destructive-foreground)]",
};

export function ApprovalCard({
  vm,
  onDecide,
}: {
  vm: ApprovalVM;
  onDecide?: (id: string, decision: "approved" | "rejected") => void;
}) {
  const { state, decided, decide } = useApprovalDecision(vm.state, (decision) => onDecide?.(vm.id, decision));
  return (
    <div data-testid={`thread-item-${vm.id}`}>
      <div
        data-testid="approval-card"
        className="ml-6 max-w-[min(42rem,calc(100%-2.5rem))] rounded-xl border border-[var(--border)] border-l-2 border-l-[var(--border)] bg-[var(--card)] px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{vm.title}</span>
          <span
            className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATE_PILL[state]}`}
          >
            {state}
          </span>
        </div>
        <p className="mt-1 text-sm leading-5 text-[var(--muted-foreground)]">{vm.description}</p>
        {!decided ? (
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              data-testid={`approval-approve-${vm.id}`}
              onClick={() => decide("approved")}
              className="flex cursor-pointer items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
            >
              <Check aria-hidden className="size-3.5" />
              Approve
            </button>
            <button
              type="button"
              data-testid={`approval-reject-${vm.id}`}
              onClick={() => decide("rejected")}
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
            >
              <X aria-hidden className="size-3.5" />
              Reject
            </button>
          </div>
        ) : (
          <p data-testid={`approval-decided-${vm.id}`} className="mt-1.5 text-xs text-[var(--muted-foreground)]">
            Decided: {state}
          </p>
        )}
      </div>
    </div>
  );
}
