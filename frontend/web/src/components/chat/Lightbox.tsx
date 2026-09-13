// components/chat/Lightbox.tsx — plain fixed-overlay image dialog. Esc or
// backdrop click closes; the image itself stops propagation so a mis-click
// on the photo doesn't dismiss it.
import { X } from "lucide-react";
import { useEffect } from "react";

import type { AttachmentVM } from "../thread/viewModel";

export function Lightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentVM;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute right-4 top-4 flex size-9 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      >
        <X className="size-5" aria-hidden />
      </button>
      <img
        src={attachment.url}
        alt={attachment.name}
        className="max-h-full max-w-full rounded-lg object-contain"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
