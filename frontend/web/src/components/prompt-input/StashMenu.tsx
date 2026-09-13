// Popup menu listing stashed composer drafts. Ported from
// refs/akeru-bot/apps/web/src/components/chat/ComposerStashMenu.tsx (MIT),
// fixture-local: plain localStorage state passed in by PromptInput instead of
// akeru's zustand store, and text-only entries (no attachment hydration).

import { useEffect, useRef } from "react";
import { FileText, X } from "lucide-react";

export type StashEntry = {
  id: string;
  text: string;
  createdAt: string;
};

const SNIPPET_MAX_CHARS = 90;

function stashEntrySnippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "(empty)";
  return trimmed.length > SNIPPET_MAX_CHARS
    ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…`
    : trimmed;
}

export function StashMenu(props: {
  entries: readonly StashEntry[];
  onRestore: (entry: StashEntry) => void;
  onDelete: (entry: StashEntry) => void;
  onClose: () => void;
}) {
  const { entries, onRestore, onDelete, onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Clicks on the stash button are the toggle; let its onClick win.
      if (target.closest('[data-testid="composer-stash"]') !== null) return;
      if (menuRef.current !== null && !menuRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      data-testid="stash-menu"
      role="menu"
      aria-label="Stashed prompts"
      className="absolute bottom-[calc(100%+8px)] left-2 z-20 w-80 overflow-hidden rounded-[var(--control-radius)] border border-border bg-card shadow-[0_16px_40px_-20px_rgb(0_0_0/60%)]"
    >
      <ul role="list" aria-label="Stashed prompts" className="max-h-64 overflow-y-auto p-1">
        {entries.length === 0 ? (
          <li className="px-3 py-2 text-sm text-muted-foreground">Nothing stashed</li>
        ) : (
          entries.map((entry, index) => (
            <li
              key={entry.id}
              data-testid={`stash-item-${index}`}
              className="group flex items-center gap-2 rounded-[var(--control-radius)] px-2 py-1.5 hover:bg-foreground/[0.06]"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                role="menuitem"
                className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm text-foreground/80 outline-none"
                title={entry.text}
                onClick={() => onRestore(entry)}
              >
                {stashEntrySnippet(entry.text)}
              </button>
              <button
                type="button"
                data-testid={`stash-delete-${index}`}
                aria-label="Delete stashed prompt"
                onClick={() => onDelete(entry)}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-60 transition-opacity hover:text-foreground group-hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
