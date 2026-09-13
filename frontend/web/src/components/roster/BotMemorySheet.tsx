// Per-bot memory sheet: memory entries CRUD over bot.memory, fixture-local.
import { useState } from "react";
import type { RosterBot } from "../../lib/roster";
import { SheetShell } from "./SheetShell";

export function BotMemorySheet({
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

  const add = () => {
    const entry = draft.trim();
    if (entry.length === 0) return;
    onUpdate(bot.id, { memory: [...memory, entry] });
    setDraft("");
  };

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} testId="bot-memory-sheet" labelledBy="bot-memory-title">
      <header className="flex items-center justify-between border-b px-6 py-5">
        <div>
          <h2 id="bot-memory-title" className="text-base font-semibold">
            {bot.name}
          </h2>
          <p className="text-xs text-muted-foreground">Memory</p>
        </div>
        <button
          type="button"
          data-testid="bot-memory-close"
          onClick={() => onOpenChange(false)}
          className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-6">
        <div className="flex gap-2">
          <input
            data-testid="memory-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            placeholder="Add a memory"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            data-testid="memory-add"
            onClick={add}
            className="h-9 shrink-0 cursor-pointer rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add
          </button>
        </div>
        {memory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No memory entries yet.</p>
        ) : (
          <ul className="space-y-2">
            {memory.map((entry, index) => (
              <li
                key={`${index}-${entry}`}
                data-testid={`memory-item-${index}`}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">{entry}</span>
                <button
                  type="button"
                  data-testid={`memory-remove-${index}`}
                  onClick={() => onUpdate(bot.id, { memory: memory.filter((_, i) => i !== index) })}
                  className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-destructive outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SheetShell>
  );
}
