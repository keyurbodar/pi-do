// Minimal modal shell standing in for akeru's ui/dialog (base-ui, MIT):
// overlay + centered panel, Escape and overlay-click to dismiss.
import { useEffect, type ReactNode } from "react";
import { cn } from "./roster.logic";

export function DialogShell({
  open,
  onOpenChange,
  testId,
  labelledBy,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-testid={testId}
        className={cn(
          "w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--shadow-float)]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
