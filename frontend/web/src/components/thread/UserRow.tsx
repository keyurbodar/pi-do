// User row — port of the ai-elements/message from=user shape (right-aligned
// bubble), visuals rewritten to the b1D0dxmC dark tokens.
import styles from "./TurnView.module.css";

export function UserRow({ text }: { text: string }) {
  return (
    <div className={styles.userRow}>
      <div className={styles.userBubble}>{text}</div>
    </div>
  );
}
