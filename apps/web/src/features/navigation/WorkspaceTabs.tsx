import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../../services/api';
import { laptopQuery, useMedia } from '../../ui/useMedia';
import { CompendiumBadge, useCompendiumCount } from '../compendium/CompendiumBadge';
import { workspaceMenu, workspacePath, type NavLink } from './links';
import { ShellOverlay } from './ShellOverlay';
import styles from './WorkspaceTabs.module.scss';

/** Workspace tab list for a role: Translations folds into More at laptop widths. */
export function useWorkspaceItems(user: Pick<User, 'role'> | null | undefined) {
  const laptop = useMedia(laptopQuery);
  return useMemo(() => {
    const { primary, more } = workspaceMenu(user);
    if (!laptop) return { primary, more };
    const folded = primary.filter(({ to }) => to === '/translations');
    // A role without a More menu keeps Translations as a tab: folding would invent a menu.
    if (!folded.length || !more.length) return { primary, more };
    return {
      primary: primary.filter(({ to }) => to !== '/translations'),
      more: [...folded, ...more],
    };
  }, [user, laptop]);
}

/**
 * Routed workspace tabs: links with aria-current, not ARIA tabs (they navigate, they do not swap
 * panels). Secondary workspaces sit behind More, a menu with roving arrow keys. A tab returns to
 * the page you last had open in that workspace.
 */
export function WorkspaceTabs({
  user,
  pathname,
  routeFor,
}: {
  user: Pick<User, 'role'> | null | undefined;
  pathname: string;
  routeFor(to: string): string;
}) {
  const { primary, more } = useWorkspaceItems(user);
  const count = useCompendiumCount();
  const current = workspacePath(pathname);
  const [open, setOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const inMore = more.some(({ to }) => to === current);
  useEffect(() => setOpen(false), [pathname]);
  const focusItem = (index: number) => {
    const items = menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items?.length) return;
    items[(index + items.length) % items.length]?.focus();
  };
  const menuKeys = (event: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') focusItem(index + 1);
    else if (event.key === 'ArrowUp') focusItem(index - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(-1);
    else return;
    event.preventDefault();
  };
  const tab = ({ to, label }: NavLink) => (
    <li key={to}>
      <Link
        to={routeFor(to)}
        className={styles.tab}
        aria-current={current === to ? 'page' : undefined}
      >
        {label}
        {to === '/compendium' && <CompendiumBadge count={count} className={styles.badge} />}
      </Link>
    </li>
  );
  return (
    <nav aria-label="Workspaces" className={styles.tabs}>
      <ul>
        {primary.map(tab)}
        {more.length > 0 && (
          <li>
            <button
              ref={moreButton}
              type="button"
              className={styles.tab}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-current={inMore ? 'page' : undefined}
              onClick={() => setOpen((value) => !value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && !open) {
                  event.preventDefault();
                  setOpen(true);
                }
              }}
            >
              More
              <span className={styles.caret} aria-hidden="true" />
            </button>
            <ShellOverlay
              open={open}
              onClose={() => setOpen(false)}
              label="More workspaces"
              anchorRef={moreButton}
              width={200}
              modal={false}
            >
              <div ref={menu} role="menu" aria-label="More workspaces" onKeyDown={menuKeys}>
                {more.map(({ to, label }, index) => (
                  <Link
                    key={to}
                    role="menuitem"
                    to={routeFor(to)}
                    className={styles.item}
                    aria-current={current === to ? 'page' : undefined}
                    data-autofocus={index === 0 ? '' : undefined}
                    onClick={() => setOpen(false)}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </ShellOverlay>
          </li>
        )}
      </ul>
    </nav>
  );
}

/** The phone workspaces sheet: every offered workspace as a 44px row. */
export function WorkspaceList({
  user,
  pathname,
  routeFor,
  onNavigate,
}: {
  user: Pick<User, 'role'> | null | undefined;
  pathname: string;
  routeFor(to: string): string;
  onNavigate(): void;
}) {
  const { primary, more } = workspaceMenu(user);
  const count = useCompendiumCount();
  const current = workspacePath(pathname);
  return (
    <nav aria-label="Workspaces" className={styles.list}>
      {[...primary, ...more].map(({ to, label }) => (
        <Link
          key={to}
          to={routeFor(to)}
          className={styles.row}
          aria-current={current === to ? 'page' : undefined}
          onClick={onNavigate}
        >
          {label}
          {to === '/compendium' && <CompendiumBadge count={count} className={styles.badge} />}
        </Link>
      ))}
    </nav>
  );
}
