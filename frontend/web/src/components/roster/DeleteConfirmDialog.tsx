// Delete confirmation dialog for sidebar rows (bots, groups).
import { DialogShell } from "./DialogShell";

export function DeleteConfirmDialog({
  open,
  label,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  label: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} testId="delete-confirm-dialog" labelledBy="delete-confirm-title">
      <div className="px-6 py-6">
        <h2 id="delete-confirm-title" className="text-base font-semibold">
          Delete {label}?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This removes {label} from the sidebar. This cannot be undone.
        </p>
      </div>
      <footer className="flex justify-end gap-2 border-t bg-muted px-6 py-4">
        <button
          type="button"
          data-testid="delete-cancel"
          onClick={() => onOpenChange(false)}
          className="h-9 cursor-pointer rounded-md border border-border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="delete-confirm"
          onClick={onConfirm}
          className="h-9 cursor-pointer rounded-md bg-destructive px-3 text-sm font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Delete
        </button>
      </footer>
    </DialogShell>
  );
}
