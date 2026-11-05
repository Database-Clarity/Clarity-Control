import { memo, useCallback, useRef, type MouseEvent } from 'react';
import { Link, useHref, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useSidebarQueueStore } from './sidebarQueue';
import styles from './Layout.module.scss';
import compendiumStyles from './CompendiumSidebarNavigation.module.scss';

const CompendiumCategoryRow = memo(function CompendiumCategoryRow({
  name,
  target,
  href,
  selected,
  open,
}: {
  name: string;
  target: string;
  href: string;
  selected: boolean;
  open: (event: MouseEvent<HTMLAnchorElement>, target: string) => void;
}) {
  return (
    <li className={compendiumStyles.row}>
      <a
        href={href}
        onClick={(event) => open(event, target)}
        aria-current={selected ? 'page' : undefined}
      >
        {name}
      </a>
    </li>
  );
});

export function CompendiumSidebarNavigation() {
  const categories = useSidebarQueueStore((state) => state.compendiumCategories);
  const [params] = useSearchParams();
  const group = params.get('group');
  const location = useLocation();
  const navigate = useNavigate();
  // Resolve the router's basename/hash prefix once. Rows retain normal native
  // anchors without each subscribing to every unrelated location change.
  const rootHref = useHref('/').replace(/\/?$/, '/');
  const currentPath = useRef('');
  currentPath.current = `${location.pathname}${location.search}${location.hash}`;
  const openEntry = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, target: string) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      void navigate(target, {
        flushSync: true,
        replace: target === currentPath.current,
      });
    },
    [navigate],
  );
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
          {categories.map((category) => {
            const target =
              category.entryTarget ??
              `/compendium/review?view=entries&group=${encodeURIComponent(category.id)}`;
            return (
              <CompendiumCategoryRow
                key={category.id}
                name={category.name}
                target={target}
                href={`${rootHref}${target.slice(1)}`}
                selected={group === category.id}
                open={openEntry}
              />
            );
          })}
        </ul>
      ) : (
        <p>No categories are waiting for review.</p>
      )}
      <Link to="/compendium/review" onClick={(event) => openEntry(event, '/compendium/review')}>
        Review matches
      </Link>
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
