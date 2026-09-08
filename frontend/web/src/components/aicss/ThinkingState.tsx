// Port of aicss ThinkingState
// (refs/aicss/packages/react/src/thinking-state). Adaptation: the label is a
// prop (upstream hardcodes "Thinking") so non-turn states can reuse the shimmer.
import styles from "./ThinkingState.module.css";

export function ThinkingState({ label = "Thinking" }: { label?: string }) {
  return <span className={styles.shimmer}>{label}</span>;
}
