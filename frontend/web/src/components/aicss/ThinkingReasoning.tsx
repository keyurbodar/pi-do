// Port of aicss ThinkingReasoning
// (refs/aicss/packages/react/src/thinking-reasoning). Mandatory adaptation:
// upstream is a self-timed demo — hardcoded sentences, reveal timers, and an
// auto-scroll viewport. Here the header, shimmer label, collapse animation,
// and chevron are verbatim; the body renders the caller's real thinking text.
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./ThinkingReasoning.module.css";

export function ThinkingReasoning({
  text,
  streaming,
  thinkingMs,
}: {
  text: string;
  streaming: boolean;
  thinkingMs: number | null;
}) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  const done = !streaming;
  const expanded = done ? open : true;
  const label = streaming
    ? "Thinking…"
    : thinkingMs !== null
      ? `Thought for ${(thinkingMs / 1000).toFixed(1)}s`
      : "Thought";
  return (
    <div className={styles.tr}>
      <button
        type="button"
        className={styles.trHeader + (done ? " " + styles.isClickable : "")}
        aria-expanded={expanded}
        aria-label="Toggle thought"
        onClick={done ? () => setOpen((v) => !v) : undefined}
      >
        {done ? (
          <span className={styles.trLabel}>
            <span className={styles.trVerb}>Thought</span>
            {label.slice("Thought".length)}
          </span>
        ) : (
          <span className={styles.trLabel + " " + styles.trShimmer}>{label}</span>
        )}
        {done && (
          <ChevronDown size={12} className={styles.trChevron} aria-hidden="true" />
        )}
      </button>
      <div className={styles.trCollapsible + (expanded ? "" : " " + styles.isCollapsed)}>
        <div className={styles.trInner}>
          {text.split("\n").map((line, i) =>
            line.length > 0 ? (
              <p key={i} className={styles.trSentence}>{line}</p>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
