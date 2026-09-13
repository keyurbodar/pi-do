// Ported from refs/akeru-bot/apps/web/src/components/roster/BotApprovalPrompt.tsx
// and chat/ComposerPendingApprovalActions.tsx (MIT — https://github.com/t3tools/akeru-bot).
// Pure UI: the parent owns the pending-approval state and interprets the
// decision; this card only renders the ask and reports the choice back.

import { Check, PencilLine, X } from "lucide-react";

export type ApprovalDecision = "approve" | "approve-with-edit" | "reject";

export function ApprovalCard({
  title,
  description,
  onDecision,
}: {
  title: string;
  description: string;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  return (
    <section
      aria-label="Approval required"
      data-testid="approval-card"
      className="w-full rounded-[1.65rem] border border-input bg-foreground/[0.08] px-3.5 pt-3 pb-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
        <p className="text-sm font-semibold text-foreground">{title}</p>
      </div>
      {description ? (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          data-testid="approval-reject"
          onClick={() => onDecision("reject")}
          className="flex h-8 items-center justify-center gap-1.5 rounded-[var(--control-radius)] border border-input px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
          Reject
        </button>
        <button
          type="button"
          data-testid="approval-approve-edit"
          onClick={() => onDecision("approve-with-edit")}
          className="flex h-8 items-center justify-center gap-1.5 rounded-[var(--control-radius)] bg-secondary px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/10"
        >
          <PencilLine className="size-3.5" />
          Approve with edit
        </button>
        <button
          type="button"
          data-testid="approval-approve"
          onClick={() => onDecision("approve")}
          className="flex h-8 items-center justify-center gap-1.5 rounded-[var(--control-radius)] bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
        >
          <Check className="size-3.5" />
          Approve
        </button>
      </div>
    </section>
  );
}
