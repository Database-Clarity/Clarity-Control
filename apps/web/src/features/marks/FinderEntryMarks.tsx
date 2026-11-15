import type { MarkDisplay } from './finder';
import styles from './marks.module.scss';

/** Static entry-only indicator; editing lives in the editor header. */
export function FinderEntryMarks({ entries }: { entries: readonly MarkDisplay[] | undefined }) {
  if (!entries?.length) return null;
  const label = entries.map((entry) => entry.label).join(', ');
  return (
    <span role="img" aria-label={label} title={label} className={styles.finderMarker}>
      ⚑
    </span>
  );
}
