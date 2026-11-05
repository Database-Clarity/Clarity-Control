import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useSidebarQueueStore } from './sidebarQueue';
import styles from './Layout.module.scss';
import compendiumStyles from './CompendiumSidebarNavigation.module.scss';

export function CompendiumSidebarNavigation() {
  const categories = useSidebarQueueStore((state) => state.compendiumCategories);
  const [params] = useSearchParams();
  const group = params.get('group');
  return (
    <nav
      aria-label="Compendium category queue"
      className={`${styles.sidebarNavigation} ${compendiumStyles.navigation}`}
    >
      <h2>Review categories</h2>
      {categories === null ? (
        <p>Open Review matches to load the category queue.</p>
      ) : categories.length ? (
        <ul className={compendiumStyles.list}>
          {categories.map((category) => (
            <li key={category.id} className={compendiumStyles.row}>
              <Link
                to={
                  category.entryTarget ??
                  `/compendium/review?view=entries&group=${encodeURIComponent(category.id)}`
                }
                aria-current={group === category.id ? 'page' : undefined}
              >
                {category.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>No categories are waiting for review.</p>
      )}
      <Link to="/compendium/review">Review matches</Link>
    </nav>
  );
}

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
        <ul className={styles.sidebarList}>
          {changes.map((change) => (
            <li key={change.hash}>
              <Link
                to={`/review?hash=${change.hash}`}
                aria-current={selectedHash === String(change.hash) ? 'page' : undefined}
              >
                {change.name} <small>{change.hash}</small>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>No saved changes are waiting to go live.</p>
      )}
    </nav>
  );
}
