// TurnError — port of the error+retry row: surfaces the turn error (plus the
// server hint when the WS frame carried one) with a Retry that re-queues the
// same prompt through onRetry.
import { RotateCcw, TriangleAlert } from "lucide-react";
import styles from "./TurnView.module.css";

export function TurnError({
  title,
  message,
  hint,
  onRetry,
}: {
  title: string;
  message: string;
  hint: string | null;
  onRetry: () => void;
}) {
  return (
    <div className={styles.errorRow} role="alert">
      <TriangleAlert size={16} className={styles.errorIcon} />
      <div className={styles.errorText}>
        <p className={styles.errorTitle}>{title}</p>
        <p className={styles.errorMessage}>{message}</p>
        {hint !== null && hint.length > 0 && <p className={styles.errorHint}>{hint}</p>}
      </div>
      <button type="button" className={styles.retryBtn} onClick={onRetry}>
        <RotateCcw size={16} />
        <span>Retry</span>
      </button>
    </div>
  );
}
