// components/chat/ThinkingRow.tsx — collapsed reasoning row ("Thought for
// Ns"), patterned on akeru's ThinkingActivityRow (MIT) but click-to-expand:
// the reasoning text stays collapsed until toggled.
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { ThinkingRowVM } from "./mapper";

export function ThinkingRow({ vm }: { vm: ThinkingRowVM }) {
  const [open, setOpen] = useState(false);
  const label =
    vm.ms !== null
      ? `Thought for ${Math.max(1, Math.round(vm.ms / 1000))}s`
      : "Thinking…";

  return (
    <div>
      <button
        type="button"
        data-testid={`thread-item-${vm.id}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-sm text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
      >
        <ChevronRight
          aria-hidden
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="tabular-nums">{label}</span>
      </button>
      {open && (
        <div className="ml-[7px] mt-1 whitespace-pre-wrap border-l border-[var(--border)] pl-3 text-sm leading-relaxed text-[var(--muted-foreground)]">
          {vm.text}
        </div>
      )}
    </div>
  );
}
