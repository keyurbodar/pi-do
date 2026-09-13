// components/chat/DelegationCard.tsx — delegated sub-task card (akeru
// DelegationCard hairline style, refs/akeru-bot, MIT): child bot avatar+name
// via BotMention, the task text, and a live status pill. Render-only; the
// mapper emits DelegationVMs from turn.delegation metadata.
import type { RosterBot } from "../../lib/roster";
import { BotMention } from "./BotMention";
import type { DelegationVM } from "./mapper";

const STATE_PILL: Record<DelegationVM["state"], string> = {
  working: "bg-[var(--warning-surface)] text-[var(--warning-foreground)]",
  done: "bg-[var(--moss-tint)] text-[var(--success-foreground)]",
  failed: "bg-[var(--flag-tint)] text-[var(--destructive-foreground)]",
};

const STATE_LABEL: Record<DelegationVM["state"], string> = {
  working: "Working",
  done: "Done",
  failed: "Failed",
};

export function DelegationCard({ vm, bots = [] }: { vm: DelegationVM; bots?: RosterBot[] }) {
  const child = bots.find((bot) => bot.id === vm.childBot);
  return (
    <div data-testid={`thread-item-${vm.id}`}>
      <div
        data-testid={`delegation-card-${vm.id}`}
        className="ml-6 max-w-[min(42rem,calc(100%-2.5rem))] rounded-xl border border-[var(--border)] border-l-2 border-l-[var(--border)] bg-[var(--card)] px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          {child !== undefined ? (
            <BotMention bot={child} />
          ) : (
            <span className="min-w-0 truncate text-sm font-medium">{vm.childBot}</span>
          )}
          <span
            data-testid={`delegation-status-${vm.id}`}
            className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATE_PILL[vm.state]}`}
          >
            {STATE_LABEL[vm.state]}
          </span>
        </div>
        <p className="mt-1 text-sm leading-5 text-[var(--muted-foreground)]">{vm.task}</p>
      </div>
    </div>
  );
}
