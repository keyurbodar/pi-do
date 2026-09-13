// Bot creation dialog, ported from akeru's NewBotDialog.tsx (MIT): name plus
// bloub identity pickers. Akeru's image upload and BotAvatarView preview are
// replaced by the placeholder avatar and the roster.ts identity unions.
import { useState, type FormEvent } from "react";
import type { BloubIdentity } from "../../lib/roster";
import BotAvatar from "./BotAvatar";
import { BLOUB_COLORS, BLOUB_EXPRESSIONS, BLOUB_SHAPES, colorHex } from "./identity";
import { DialogShell } from "./DialogShell";
import { cn } from "./roster.logic";

export function NewBotDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; identity: BloubIdentity }) => void;
}) {
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState<BloubIdentity>(() => ({
    shape: "cercle",
    color: "bleu",
    expression: "neutre",
  }));
  const trimmedName = name.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmedName.length === 0) return;
    onCreate({ name: trimmedName, identity });
  };

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} testId="new-bot-dialog" labelledBy="new-bot-title">
      <form onSubmit={submit}>
        <header className="border-b px-6 py-5">
          <h2 id="new-bot-title" className="text-base font-semibold">
            New bot
          </h2>
        </header>

        <div className="space-y-6 px-6 py-6">
          <div className="flex items-center gap-4">
            <BotAvatar identity={identity} size={64} />
            <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium">
              Name
              <input
                autoFocus
                data-testid="new-bot-name-input"
                maxLength={80}
                placeholder="Bot name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-9 rounded-md border border-input bg-input px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>

          <section aria-labelledby="new-bot-shape-heading" className="space-y-3 border-t pt-5">
            <h3 id="new-bot-shape-heading" className="text-sm font-medium">
              Shape
            </h3>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {BLOUB_SHAPES.map((shape) => {
                const selected = identity.shape === shape;
                return (
                  <button
                    key={shape}
                    type="button"
                    aria-label={shape}
                    aria-pressed={selected}
                    data-testid={`new-bot-shape-${shape}`}
                    onClick={() => setIdentity((prev) => ({ ...prev, shape }))}
                    className={cn(
                      "flex aspect-square cursor-pointer items-center justify-center rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      selected ? "border-border bg-accent" : "border-transparent hover:bg-accent/60",
                    )}
                  >
                    <BotAvatar
                      identity={{ ...identity, shape }}
                      size={36}
                    />
                  </button>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="new-bot-color-heading" className="space-y-3 border-t pt-5">
            <h3 id="new-bot-color-heading" className="text-sm font-medium">
              Color
            </h3>
            <div className="flex flex-wrap gap-2.5">
              {BLOUB_COLORS.map((color) => {
                const selected = identity.color === color;
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    aria-pressed={selected}
                    data-testid={`new-bot-color-${color}`}
                    title={color}
                    onClick={() => setIdentity((prev) => ({ ...prev, color }))}
                    style={{ backgroundColor: colorHex(color) }}
                    className={cn(
                      "size-8 cursor-pointer rounded-full border border-white/10 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "ring-2 ring-ring ring-offset-2 ring-offset-popover",
                    )}
                  />
                );
              })}
            </div>
          </section>

          <section aria-labelledby="new-bot-expression-heading" className="space-y-3 border-t pt-5">
            <h3 id="new-bot-expression-heading" className="text-sm font-medium">
              Expression
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {BLOUB_EXPRESSIONS.map((expression) => {
                const selected = identity.expression === expression;
                return (
                  <button
                    key={expression}
                    type="button"
                    aria-pressed={selected}
                    data-testid={`new-bot-expression-${expression}`}
                    onClick={() => setIdentity((prev) => ({ ...prev, expression }))}
                    className={cn(
                      "cursor-pointer rounded-full border px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {expression}
                  </button>
                );
              })}
            </div>
          </section>
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
            data-testid="new-bot-create"
            disabled={trimmedName.length === 0}
            className="h-9 cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create bot
          </button>
        </footer>
      </form>
    </DialogShell>
  );
}
