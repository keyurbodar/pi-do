// components/chat/CodeBlock.tsx — grok-style code card: plain pre block with
// a language label and a copy button reporting Copied feedback.
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CodeBlock({
  code,
  language = "text",
}: {
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = code;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch {
        return;
      }
    }
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      data-testid="code-block"
      className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
        <span data-testid="code-language" className="text-xs font-medium text-[var(--muted-foreground)]">
          {language}
        </span>
        <button
          type="button"
          data-testid="code-copy"
          aria-label="Copy code"
          title="Copy code"
          onClick={() => void copy()}
          className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
        >
          {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
      {copied && (
        <span data-testid="code-copied" className="sr-only">
          Copied
        </span>
      )}
    </div>
  );
}
