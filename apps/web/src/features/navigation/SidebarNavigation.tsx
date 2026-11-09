import { useLocation } from 'react-router-dom';
import { useSidebarQueueStore } from './sidebarQueue';
import styles from './Layout.module.scss';
import { ReviewQueue } from '../review/ReviewQueue';
import '../review/model';

export function ReviewSidebarNavigation() {
  const changes = useSidebarQueueStore((state) => state.pendingChanges);
  const location = useLocation();
  const selectedHash = new URLSearchParams(location.search).get('hash');
  return (
    <nav aria-label="Pending saved changes" className={styles.sidebarNavigation}>
      <h2>Pending saved changes</h2>
      {changes === null ? (
        <p>Loading saved changes…</p>
      ) : changes.length ? (
        <ReviewQueue changes={changes} selectedHash={selectedHash} />
      ) : (
        <p>No saved changes are waiting to go live.</p>
      )}
    </nav>
  );
}
