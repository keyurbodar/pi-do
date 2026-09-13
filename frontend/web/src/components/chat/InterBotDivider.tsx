// components/chat/InterBotDivider.tsx — akeru-style divider for messages
// folded in from other roster bots ("Messages from Account Manager and
// Chief"). Render-only: the mapper emits InterBotMessageVMs once turn
// metadata carries them; until then only fixtures drive this component.
import type { InterBotMessageVM } from "../thread/viewModel";

export function InterBotDivider({ vm }: { vm: InterBotMessageVM }) {
  return (
    <div data-testid={`thread-item-${vm.id}`}>
      <div
        data-testid="inter-bot-divider"
        className="flex items-center gap-3 py-1 text-xs text-[var(--muted-foreground)]"
        role="separator"
        aria-label={vm.text}
      >
        <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
        <span className="max-w-[70%] truncate">{vm.text}</span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
      </div>
    </div>
  );
}
