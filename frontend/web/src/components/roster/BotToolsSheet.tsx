// Per-bot tools sheet: per-tool enable toggles plus a usage section with a
// static usage bar. Fixture-local via onUpdate.
import { BOT_TOOLS, type RosterBot } from "../../lib/roster";
import { SheetShell } from "./SheetShell";
import { cn } from "./roster.logic";

export function BotToolsSheet({
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
  const overrides = bot.toolOverrides ?? {};
  const enabledCount = BOT_TOOLS.filter((tool) => overrides[tool] ?? true).length;
  const usagePercent = Math.round((enabledCount / BOT_TOOLS.length) * 100);
  const cap = bot.usageCap ?? 0;

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} testId="bot-tools-sheet" labelledBy="bot-tools-title">
      <header className="flex items-center justify-between border-b px-6 py-5">
        <div>
          <h2 id="bot-tools-title" className="text-base font-semibold">
            {bot.name}
          </h2>
          <p className="text-xs text-muted-foreground">Tools &amp; usage</p>
        </div>
        <button
          type="button"
          data-testid="bot-tools-close"
          onClick={() => onOpenChange(false)}
          className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Tools</h3>
          <ul className="space-y-2">
            {BOT_TOOLS.map((tool) => {
              const enabled = overrides[tool] ?? true;
              return (
                <li key={tool} className="flex items-center justify-between gap-4">
                  <span className="text-sm capitalize">{tool}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    data-testid={`tool-toggle-${tool}`}
                    onClick={() => onUpdate(bot.id, { toolOverrides: { ...overrides, [tool]: !enabled } })}
                    className={cn(
                      "relative h-6 w-11 shrink-0 cursor-pointer rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      enabled ? "bg-primary" : "bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                        enabled ? "left-[22px]" : "left-0.5",
                      )}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="space-y-3 border-t pt-5" aria-label="Usage">
          <h3 className="text-sm font-medium">Usage</h3>
          <div
            data-testid="tool-usage-bar"
            role="progressbar"
            aria-valuenow={usagePercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Tools enabled ${enabledCount} of ${BOT_TOOLS.length}`}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${usagePercent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {enabledCount} of {BOT_TOOLS.length} tools enabled
            {cap > 0 ? ` · cap ${cap}` : " · uncapped"}
          </p>
          <input
            type="number"
            min={0}
            data-testid="tool-usage-cap-input"
            aria-label="Usage cap"
            value={cap}
            onChange={(event) => {
              const next = Number(event.target.value);
              onUpdate(bot.id, { usageCap: Number.isFinite(next) && next >= 0 ? Math.floor(next) : 0 });
            }}
            className="h-9 w-full rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </section>
      </div>
    </SheetShell>
  );
}
