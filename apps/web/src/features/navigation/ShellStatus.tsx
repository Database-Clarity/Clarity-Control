import { useLocation } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { canonicalHash } from './catalog';
import { count } from './notices';
import { useShellColumn } from './ShellColumnContext';
import styles from './ShellStatus.module.scss';

/**
 * A fixed-height line under the editor: whether the preview column is shown, and how many changes
 * have not been shown in it yet. Present whenever the page has a preview column to collapse, so
 * nothing above it moves when the column is hidden or shown. Phase 2's editor status bar takes this over.
 */
export function ShellStatus() {
  const column = useShellColumn();
  const hosted = usePreviewReviewStore((state) => state.host !== null);
  const entries = usePreviewReviewStore((state) => state.entries);
  const data = useDataStore((state) => state.data);
  const { pathname } = useLocation();
  if (!column || !hosted) return null;
  const hash = Number(pathname.split('/')[2]);
  const item = data && Number.isFinite(hash) ? canonicalHash(hash, data) : undefined;
  const unreviewed = Object.values(entries).filter(
    (entry) => entry.canonical === item && entry.dirty > entry.reviewed,
  ).length;
  return (
    <div className={styles.status} data-shell-status data-attention={unreviewed > 0 || undefined}>
      <span className={styles.text}>
        {column.collapsed
          ? unreviewed > 0
            ? `Preview collapsed: ${count(unreviewed, 'change')} not reviewed`
            : 'Preview collapsed'
          : 'Preview shown'}
      </span>
      <button type="button" onClick={column.collapsed ? column.show : column.toggle}>
        {column.collapsed ? 'Show preview' : 'Hide preview'}
        <kbd>Alt+P</kbd>
      </button>
    </div>
  );
}
