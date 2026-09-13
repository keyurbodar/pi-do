// components/chat/BotMention.tsx — inline mention chip (akeru roster-mention
// pattern): a mini bloub avatar next to the bot's name, tinted with the bot's
// bloub color. Pure presentation; the caller resolves the RosterBot.
import { BotAvatar } from "../roster";
import { colorHex } from "../roster/identity";
import type { RosterBot } from "../../lib/roster";

export function BotMention({ bot }: { bot: RosterBot }) {
  return (
    <span
      data-testid={`bot-mention-${bot.id}`}
      className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-1.5 py-0.5 align-baseline text-sm font-medium whitespace-nowrap"
      style={{ color: colorHex(bot.bloub.color) }}
    >
      <BotAvatar identity={bot.bloub} size={13} />
      <span>{bot.name}</span>
    </span>
  );
}
