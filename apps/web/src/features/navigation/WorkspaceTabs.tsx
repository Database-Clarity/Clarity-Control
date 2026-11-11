import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MenuUser } from './links';
import { driftTabQuery, laptopQuery, managementTabQuery, useMedia } from '../../ui/useMedia';
import { CompendiumBadge, useCompendiumCount } from '../compendium/CompendiumBadge';
import { workspaceMenu, workspacePath, type NavLink } from './links';
import { ShellOverlay } from './ShellOverlay';
import { AccountPicture, useIdentity } from './IdentityMenu';
import { GearIcon } from './SettingsButton';
import styles from './WorkspaceTabs.module.scss';

/**
 * Workspace tab list for a role: Translations folds into More at laptop widths; on wide screens
 * Bungie drift, then Management, move out of More into the tabs (each only from its measured
 * width, where it fits without shrinking the finder or another tab).
 */
export function useWorkspaceItems(user: MenuUser | null | undefined) {
  const laptop = useMedia(laptopQuery);
  const driftTab = useMedia(driftTabQuery);
  const managementTab = useMedia(managementTabQuery);
  return useMemo(() => {
    const menu = workspaceMenu(user);
    let { primary, more } = menu;
    if (driftTab) {
      const promoted = more.filter(
        ({ to }) => to === '/drift' || (managementTab && to === '/management'),
      );
      primary = [...primary, ...promoted];
      more = more.filter((link) => !promoted.includes(link));
    }
    if (!laptop) return { primary, more };
    const folded = primary.filter(({ to }) => to === '/translations');
    // A role without a More menu keeps Translations as a tab: folding would invent a menu.
    if (!folded.length || !more.length) return { primary, more };
    return {
      primary: primary.filter(({ to }) => to !== '/translations'),
      more: [...folded, ...more],
    };
  }, [user, laptop, driftTab, managementTab]);
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
  user: MenuUser | null | undefined;
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

/**
 * The phone's Clarity menu: every offered workspace as a row, then, under a rule, Settings and the
 * account (both leave the phone header so the title has room). Settings and the account sheet
 * return focus to the Clarity mark when they close.
 */
export function WorkspaceList({
  user,
  pathname,
  routeFor,
  onNavigate,
  onSettings,
  onAccount,
}: {
  user: MenuUser | null | undefined;
  pathname: string;
  routeFor(to: string): string;
  onNavigate(): void;
  /** Phones: opens Settings. */
  onSettings?(): void;
  /** Phones: opens the Account sheet. */
  onAccount?(): void;
}) {
  const { primary, more } = workspaceMenu(user);
  const count = useCompendiumCount();
  const current = workspacePath(pathname);
  return (
    <>
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
      {onSettings && onAccount && <AccountRows onSettings={onSettings} onAccount={onAccount} />}
    </>
  );
}

function AccountRows({ onSettings, onAccount }: { onSettings(): void; onAccount(): void }) {
  const { user, summary, dataError } = useIdentity();
  const pictured = summary.tone === 'ok' && user;
  const problem = summary.tone === 'error' || dataError;
  return (
    <div className={styles.account} role="group" aria-label="Settings and account">
      <button type="button" className={styles.row} aria-haspopup="dialog" onClick={onSettings}>
        <span className={styles.lead}>
          <GearIcon className={styles.icon} />
          Settings
        </span>
      </button>
      <button
        type="button"
        className={styles.row}
        data-identity-row
        data-tone={summary.tone}
        aria-haspopup="dialog"
        aria-label={`Account: ${summary.detail}${dataError ? ` (cannot load editor data)` : ''}`}
        onClick={onAccount}
      >
        <span className={styles.lead}>
          {/* Without a picture (Sign in, checking, a problem) the text keeps Settings' icon slot. */}
          {pictured ? (
            <AccountPicture id={user.id} login={user.login} />
          ) : (
            <span className={styles.icon} aria-hidden="true" />
          )}
          {summary.label}
        </span>
        {pictured ? (
          <span className={styles.role}>{user.role ?? 'no editing role'}</span>
        ) : (
          problem && (
            <span className={styles.problem}>
              {summary.tone === 'error' ? summary.detail : 'Cannot load editor data'}
            </span>
          )
        )}
      </button>
    </div>
  );
}
