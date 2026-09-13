// Right-side sheet shell, mirroring akeru's ui/sheet pattern (overlay +
// right-docked panel, Escape and overlay-click to dismiss). The centered
// DialogShell stays for true dialogs; sheets use this.
import { useEffect, type ReactNode } from "react";
import { cn } from "./roster.logic";

export function SheetShell({
  open,
  onOpenChange,
  testId,
  labelledBy,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  labelledBy: string;
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
      className="fixed inset-0 z-50 bg-black/60"
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
          "absolute top-0 right-0 flex h-full w-full max-w-md flex-col border-l border-border",
          "bg-popover text-popover-foreground shadow-[var(--shadow-float)]",
        )}
      >
        {children}
      </div>
    </div>
  );
}
