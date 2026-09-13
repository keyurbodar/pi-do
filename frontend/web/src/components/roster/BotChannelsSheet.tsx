// Per-bot channels sheet: static provider list (slack, gmail, discord) with
// connect/disconnect buttons and status pills. Fixture-local via onUpdate.
import { CHANNEL_PROVIDERS, type RosterBot } from "../../lib/roster";
import { SheetShell } from "./SheetShell";
import { cn } from "./roster.logic";

export function BotChannelsSheet({
  bot,
  open,
  onOpenChange,
  onUpdate,
}: {
  bot: RosterBot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (id: string, patch: Partial<RosterBot>) => void;
}) {
  if (!open || bot === null) return null;
  const channels = bot.channels ?? {};
  return (
    <SheetShell open={open} onOpenChange={onOpenChange} testId="bot-channels-sheet" labelledBy="bot-channels-title">
      <header className="flex items-center justify-between border-b px-6 py-5">
        <div>
          <h2 id="bot-channels-title" className="text-base font-semibold">
            {bot.name}
          </h2>
          <p className="text-xs text-muted-foreground">Channels</p>
        </div>
        <button
          type="button"
          data-testid="bot-channels-close"
          onClick={() => onOpenChange(false)}
          className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Close
        </button>
      </header>
      <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-6">
        {CHANNEL_PROVIDERS.map((provider) => {
          const connected = channels[provider] === true;
          return (
            <li
              key={provider}
              className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium capitalize">{provider}</span>
                <span
                  data-testid={`channel-status-${provider}`}
                  className={cn(
                    "mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                    connected ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                  )}
                >
                  {connected ? "Connected" : "Disconnected"}
                </span>
              </span>
              <button
                type="button"
                data-testid={`channel-connect-${provider}`}
                onClick={() => onUpdate(bot.id, { channels: { ...channels, [provider]: !connected } })}
                className="h-9 shrink-0 cursor-pointer rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {connected ? "Disconnect" : "Connect"}
              </button>
            </li>
          );
        })}
      </ul>
    </SheetShell>
  );
}
