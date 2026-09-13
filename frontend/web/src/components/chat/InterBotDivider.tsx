// components/chat/InterBotDivider.tsx — akeru-style divider for messages
// folded in from other roster bots: a centered muted row reading
// "Messages from [Account Manager] and [Chief]", each name a BotMention chip
// with its mini bloub. Render-only; the mapper emits InterBotMessageVMs when
// turn.interBotFrom carries the folded-in bot ids.
import type { RosterBot } from "../../lib/roster";
import type { InterBotMessageVM } from "../thread/viewModel";
import { BotMention } from "./BotMention";

export function InterBotDivider({ vm, bots = [] }: { vm: InterBotMessageVM; bots?: RosterBot[] }) {
  const fromBots = vm.fromBotIds
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot) => bot !== undefined);

  return (
    <div data-testid={`thread-item-${vm.id}`}>
      <div
        data-testid="inter-bot-divider"
        className="flex items-center gap-3 py-1 text-xs text-[var(--muted-foreground)]"
        role="separator"
        aria-label={fromBots.length > 0 ? `Messages from ${fromBots.map((b) => b.name).join(" and ")}` : vm.text}
      >
        <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">Messages from</span>
          {fromBots.map((bot, i) => (
            <span key={bot.id} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden>and</span>}
              <BotMention bot={bot} />
            </span>
          ))}
        </span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--border)]" />
      </div>
    </div>
  );
}
