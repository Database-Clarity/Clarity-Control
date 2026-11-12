import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import styles from './MyReportsEntry.module.scss';

/**
 * "My reports" in the account sheet, for signed-in accounts. It reads `/reports/mine` only while
 * the sheet is open (one request per opening) and loads the report client on demand, so the
 * editor's own bundle carries this link and nothing else.
 */
export function MyReportsEntry({ onNavigate }: { onNavigate?: () => void }) {
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([import('../../../services/reports'), import('./seen')])
      .then(([{ myReports }, { changedSince }]) => myReports(controller.signal).then(changedSince))
      .then((ids) => setChanged(ids.size > 0))
      .catch(() => setChanged(false));
    return () => controller.abort();
  }, []);
  return (
    <Link
      to="/report/mine"
      onClick={onNavigate}
      aria-label={changed ? 'My reports, updated since your last visit' : undefined}
    >
      My reports
      {changed && <span className={styles.dot} aria-hidden="true" />}
    </Link>
  );
}
