// Per-bot details sheet: voice, memory, sandbox, tool overrides, usage cap.
// Fixture-local: every control writes through onUpdate into the roster state
// (persisted to localStorage by useRosterState).
import { useState } from "react";
import { BOT_SANDBOXES, BOT_TOOLS, type RosterBot } from "../../lib/roster";
import { SheetShell } from "./SheetShell";
import { BotRoutinesSection } from "./BotRoutinesSection";
import { cn } from "./roster.logic";

export function BotDetailsPanel({
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
  const [draft, setDraft] = useState("");
  if (!open || bot === null) return null;
  const memory = bot.memory ?? [];
  const overrides = bot.toolOverrides ?? {};

  const addMemory = () => {
    const entry = draft.trim();
    if (entry.length === 0) return;
    onUpdate(bot.id, { memory: [...memory, entry] });
    setDraft("");
  };

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} testId="bot-details-sheet" labelledBy="bot-details-title">
      <header className="flex items-center justify-between border-b px-6 py-5">
        <div>
          <h2 id="bot-details-title" className="text-base font-semibold">
            {bot.name}
          </h2>
          <p className="text-xs text-muted-foreground">Bot details</p>
        </div>
        <button
          type="button"
          data-testid="bot-details-close"
          onClick={() => onOpenChange(false)}
          className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <section className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">Voice</h3>
            <p className="text-xs text-muted-foreground">Let this bot speak replies aloud.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={bot.voiceEnabled === true}
            data-testid="detail-voice-toggle"
            onClick={() => onUpdate(bot.id, { voiceEnabled: !(bot.voiceEnabled === true) })}
            className={cn(
              "relative h-6 w-11 shrink-0 cursor-pointer rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              bot.voiceEnabled === true ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                bot.voiceEnabled === true ? "left-[22px]" : "left-0.5",
              )}
            />
          </button>
        </section>

        <section className="space-y-3 border-t pt-5">
          <h3 className="text-sm font-medium">Memory</h3>
          {memory.length === 0 ? (
            <p className="text-xs text-muted-foreground">No memory entries yet.</p>
          ) : (
            <ul className="space-y-2">
              {memory.map((entry, index) => (
                <li
                  key={`${index}-${entry}`}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{entry}</span>
                  <button
                    type="button"
                    data-testid={`detail-memory-remove-${index}`}
                    onClick={() => onUpdate(bot.id, { memory: memory.filter((_, i) => i !== index) })}
                    className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-destructive outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              data-testid="detail-memory-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addMemory();
                }
              }}
              placeholder="Add a memory"
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              data-testid="detail-memory-add"
              onClick={addMemory}
              className="h-9 shrink-0 cursor-pointer rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Add
            </button>
          </div>
        </section>

        <section className="space-y-3 border-t pt-5">
          <h3 className="text-sm font-medium">Sandbox</h3>
          <select
            data-testid="detail-sandbox-select"
            value={bot.sandbox ?? "none"}
            onChange={(event) => onUpdate(bot.id, { sandbox: event.target.value as RosterBot["sandbox"] })}
            className="h-9 w-full cursor-pointer rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {BOT_SANDBOXES.map((sandbox) => (
              <option key={sandbox} value={sandbox}>
                {sandbox}
              </option>
            ))}
          </select>
        </section>

        <section className="space-y-3 border-t pt-5">
          <h3 className="text-sm font-medium">Tool overrides</h3>
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
                    data-testid={`detail-tool-${tool}`}
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

        <section className="space-y-3 border-t pt-5">
          <h3 className="text-sm font-medium">Usage cap</h3>
          <input
            type="number"
            min={0}
            data-testid="detail-usage-cap-input"
            value={bot.usageCap ?? 0}
            onChange={(event) => {
              const next = Number(event.target.value);
              onUpdate(bot.id, { usageCap: Number.isFinite(next) && next >= 0 ? Math.floor(next) : 0 });
            }}
            className="h-9 w-full rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">0 means uncapped.</p>
        </section>

        <BotRoutinesSection bot={bot} />
      </div>
    </SheetShell>
  );
}
