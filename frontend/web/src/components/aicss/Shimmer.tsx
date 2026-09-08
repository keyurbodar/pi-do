// Port of the beautiful-ui Shimmer atom
// (refs/beautiful-ui/components/atoms/Shimmer.tsx). Adaptation: upstream uses
// Tailwind classes and --ink vars; here a CSS module on our theme tokens.
import styles from "./Shimmer.module.css";

export function Shimmer({ children }: { children: string }) {
  return <span className={styles.shimmer}>{children}</span>;
}
