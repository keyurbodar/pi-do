// Group creation dialog, ported from akeru's NewGroupDialog.tsx (MIT) and
// reduced to the RosterGroup contract: a name plus a multi-select of member
// bots (akeru's boss/specialist split has no equivalent in the contract).
import { useState } from "react";
import type { RosterBot } from "../../lib/roster";
import BotAvatar from "./BotAvatar";
import { DialogShell } from "./DialogShell";

export function canCreateGroup(name: string, selectedIds: readonly string[]): boolean {
  return name.trim().length > 0 && new Set(selectedIds).size >= 2;
}

export function NewGroupDialog({
  open,
  bots,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  bots: readonly RosterBot[];
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; memberIds: string[] }) => void;
}) {
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(() => bots.slice(0, 2).map((bot) => bot.id));
  const trimmedName = name.trim();

  const toggleMember = (botId: string) => {
    setSelectedIds((prev) =>
      prev.includes(botId) ? prev.filter((id) => id !== botId) : [...prev, botId],
    );
  };

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} testId="new-group-dialog" labelledBy="new-group-title">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreateGroup(trimmedName, selectedIds)) return;
          onCreate({ name: trimmedName, memberIds: [...selectedIds] });
        }}
      >
        <header className="border-b px-6 py-5">
          <h2 id="new-group-title" className="text-base font-semibold">
            New group
          </h2>
        </header>

        <div className="space-y-5 px-6 py-6">
          <label className="flex flex-col gap-2 text-sm font-medium">
            Name
            <input
              autoFocus
              data-testid="new-group-name-input"
              maxLength={80}
              placeholder="Group name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-9 rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Members</legend>
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
              {bots.map((bot) => {
                const checked = selectedIds.includes(bot.id);
                return (
                  <label
                    key={bot.id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      data-testid={`new-group-member-${bot.id}`}
                      checked={checked}
                      onChange={() => toggleMember(bot.id)}
                      className="size-4 accent-[var(--primary)]"
                    />
                    <BotAvatar identity={bot.bloub} size={20} />
                    <span className="truncate">{bot.name}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>

        <footer className="flex justify-end gap-2 border-t bg-muted px-6 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-9 cursor-pointer rounded-md border border-border px-4 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="new-group-create"
            disabled={!canCreateGroup(trimmedName, selectedIds)}
            className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create group
          </button>
        </footer>
      </form>
    </DialogShell>
  );
}
