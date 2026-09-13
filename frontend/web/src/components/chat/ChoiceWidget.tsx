// components/chat/ChoiceWidget.tsx — inline question with A/B/C option rows
// plus a type-your-own field (UserInputCard pattern). Picking calls the
// optional onPick and flips to a local answered state so the widget reads
// decided even with no backend behind it.
import { useState } from "react";

const OPTION_MARKS = ["A", "B", "C", "D", "E", "F"] as const;

export function ChoiceWidget({
  title,
  subtitle,
  options = ["Option A", "Option B", "Option C"],
  onPick,
}: {
  title: string;
  subtitle?: string;
  options?: readonly string[];
  onPick?: (option: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [answered, setAnswered] = useState<string | null>(null);

  const pick = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || answered !== null) return;
    setAnswered(trimmed);
    onPick?.(trimmed);
  };

  return (
    <div
      data-testid="choice-widget"
      className="w-fit max-w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2"
    >
      <p className="text-sm font-medium">{title}</p>
      {subtitle !== undefined && (
        <p data-testid="choice-subtitle" className="mt-0.5 text-xs text-[var(--muted-foreground)]">
          {subtitle}
        </p>
      )}
      {answered !== null ? (
        <p data-testid="choice-answered" className="mt-1.5 text-sm text-[var(--muted-foreground)]">
          Picked: {answered}
        </p>
      ) : (
        <>
          <div className="mt-2 space-y-1.5">
            {options.map((option, index) => (
              <button
                key={`${option}:${index}`}
                type="button"
                data-testid={`choice-option-${index}`}
                onClick={() => pick(option)}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
              >
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-[var(--muted-foreground)]"
                >
                  {OPTION_MARKS[index % OPTION_MARKS.length]}
                </span>
                <span className="min-w-0 flex-1">{option}</span>
              </button>
            ))}
          </div>
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              pick(draft);
            }}
          >
            <input
              data-testid="choice-input"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="Type your own…"
              aria-label="Type your own answer"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--muted-foreground)]/70 focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
            />
            <button
              type="submit"
              data-testid="choice-submit"
              disabled={draft.trim().length === 0}
              className="shrink-0 cursor-pointer rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </>
      )}
    </div>
  );
}
