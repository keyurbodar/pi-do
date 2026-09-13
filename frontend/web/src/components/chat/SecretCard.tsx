// components/chat/SecretCard.tsx — masked credential prompt with a reveal
// toggle. Submitting calls the optional onSubmitKey and flips to a local
// stored state so the card reads decided even with no backend behind it.
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

export function SecretCard({
  title = "Enter your API key",
  description,
  onSubmitKey,
}: {
  title?: string;
  description?: string;
  onSubmitKey?: (key: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [stored, setStored] = useState(false);

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || stored) return;
    setStored(true);
    onSubmitKey?.(trimmed);
  };

  return (
    <div
      data-testid="secret-card"
      className="w-fit max-w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2"
    >
      <p className="text-sm font-medium">{title}</p>
      {description !== undefined && (
        <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{description}</p>
      )}
      {stored ? (
        <p data-testid="secret-stored" className="mt-1.5 text-sm text-[var(--muted-foreground)]">
          Key stored.
        </p>
      ) : (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex min-w-0 flex-1 items-center rounded-lg border border-[var(--border)] bg-transparent focus-within:ring-2 focus-within:ring-[var(--ring)]/70">
            <input
              data-testid="secret-input"
              type={revealed ? "text" : "password"}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="Paste secret…"
              aria-label="Secret key"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--muted-foreground)]/70"
            />
            <button
              type="button"
              data-testid="secret-toggle"
              aria-label={revealed ? "Hide secret" : "Show secret"}
              aria-pressed={revealed}
              onClick={() => setRevealed((v) => !v)}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
            >
              {revealed ? (
                <EyeOff aria-hidden className="size-3.5" />
              ) : (
                <Eye aria-hidden className="size-3.5" />
              )}
            </button>
          </div>
          <button
            type="submit"
            data-testid="secret-submit"
            disabled={draft.trim().length === 0}
            className="shrink-0 cursor-pointer rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            Save
          </button>
        </form>
      )}
    </div>
  );
}
