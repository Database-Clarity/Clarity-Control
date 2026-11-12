import { useRawDiff } from './diffPreference';
import styles from './RenderedWordDiff.module.scss';

export function RawDiffToggle() {
  const [raw, setRaw] = useRawDiff();
  return (
    <button
      type="button"
      role="switch"
      aria-label="Raw diff"
      aria-checked={raw}
      className={styles.toggle}
      onClick={() => setRaw(!raw)}
    >
      Raw
    </button>
  );
}
