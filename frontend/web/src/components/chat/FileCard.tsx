// components/chat/FileCard.tsx — grok-style file attachment card: file name,
// human size, download anchor, and hover actions (download + open).
import { Download, ExternalLink, FileText } from "lucide-react";

export function FileCard({
  name,
  size,
  url,
  onDownload,
  onOpen,
}: {
  name: string;
  size: string;
  /** Download/open href; when absent the actions fall back to callbacks. */
  url?: string;
  onDownload?: () => void;
  onOpen?: () => void;
}) {
  return (
    <div
      data-testid="file-card"
      className="group flex w-fit max-w-full items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--muted-foreground)]">
        <FileText aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block max-w-[220px] truncate text-sm font-medium">{name}</span>
        <span className="block text-xs text-[var(--muted-foreground)]">{size}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
        {url !== undefined ? (
          <a
            href={url}
            download={name}
            data-testid="file-download"
            aria-label={`Download ${name}`}
            onClick={() => onDownload?.()}
            className="flex size-7 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
          >
            <Download aria-hidden className="size-3.5" />
          </a>
        ) : (
          <button
            type="button"
            data-testid="file-download"
            aria-label={`Download ${name}`}
            onClick={() => onDownload?.()}
            className="flex size-7 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
          >
            <Download aria-hidden className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          data-testid="file-open"
          aria-label={`Open ${name}`}
          onClick={() => onOpen?.()}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/70"
        >
          <ExternalLink aria-hidden className="size-3.5" />
        </button>
      </span>
    </div>
  );
}
