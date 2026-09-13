// components/chat/UserInputCard.tsx — inline question with quick-reply
// option buttons plus a free-text field (akeru BotUserInputPrompt pattern,
// refs/akeru-bot, MIT, stripped of its store layer). Answering calls the
// optional onAnswer (default no-op) and flips to a local answered state so
// the card reads decided even with no backend behind it.
import { useState } from "react";

import type { UserInputVM } from "./mapper";

export function UserInputCard({
  vm,
  onAnswer,
}: {
  vm: UserInputVM;
  onAnswer?: (id: string, answer: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [answered, setAnswered] = useState<string | null>(null);

  const answer = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || answered !== null) return;
    setAnswered(trimmed);
    onAnswer?.(vm.id, trimmed);
  };

  return (
    <div data-testid={`thread-item-${vm.id}`}>
      <div
        data-testid={`userinput-card-${vm.id}`}
        className="ml-6 max-w-[min(42rem,calc(100%-2.5rem))] rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2"
      >
        <p className="text-sm font-medium">{vm.question}</p>
        {answered !== null ? (
          <p data-testid={`userinput-answered-${vm.id}`} className="mt-1.5 text-sm text-[var(--muted-foreground)]">
            Answered: {answered}
          </p>
        ) : (
          <>
            {vm.options.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {vm.options.map((option, index) => (
                  <button
                    key={`${option}:${index}`}
                    type="button"
                    data-testid={`userinput-option-${vm.id}-${index}`}
                    onClick={() => answer(option)}
                    className="cursor-pointer rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <form
              className="mt-2 flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                answer(draft);
              }}
            >
              <input
                data-testid={`userinput-text-${vm.id}`}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder="Type an answer…"
                aria-label="Answer"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--muted-foreground)]/70 focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
              />
              <button
                type="submit"
                data-testid={`userinput-submit-${vm.id}`}
                disabled={draft.trim().length === 0}
                className="shrink-0 cursor-pointer rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
