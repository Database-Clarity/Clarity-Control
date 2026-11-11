import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { MenuUser } from './links';
import { BrandMark } from './Brand';
import { DraftButton } from './DraftButton';
import { AccountSheet, useIdentity } from './IdentityMenu';
import { useAuthSession } from '../auth/AuthStatus';
import { useSettingsPanel } from '../settings/panel';
import { ShellOverlay } from './ShellOverlay';
import { FinderSheetCloseContext, FinderSheetContext } from './FinderSheetContext';
import { WorkspaceList } from './WorkspaceTabs';
import { useSteppingActivity } from './steppingActivity';
import { useDataStore } from '../../stores/data';
import { editorName, exoticPiece, itemFor } from './catalog';
import { titleWidthEm } from '../preview/nameFit';
import styles from './PhoneHeader.module.scss';

/**
 * Phone header (<= 700px), var(--bar) high, three things only: the Clarity mark opens the menu
 * (workspaces, then Settings and the account), the title opens the finder sheet (or just names the
 * page where there is no finder), then Drafts. Sheets replace the desktop popovers; the finder
 * sheet stays mounted while closed because the stepping listeners live in it. A login problem or a
 * data-load error puts a danger dot on the mark, since the account is in the menu.
 */
export function PhoneHeader({
  user,
  pathname,
  routeFor,
  title,
  kicker,
  finder,
  hasFinder,
  overlay,
}: {
  user: MenuUser | null | undefined;
  pathname: string;
  routeFor(to: string): string;
  title: string;
  /** A line above the title naming what it belongs to (the exotic armour piece carrying a perk). */
  kicker?: string;
  finder: ReactNode;
  /** Whether the current workspace has anything to find or browse. */
  hasFinder: boolean;
  /** Notices that hang from the header's lower edge without taking space. */
  overlay?: ReactNode;
}) {
  const target = useSteppingActivity((state) => state.target);
  const data = useDataStore((state) => state.data);
  const item =
    target && pathname.startsWith('/t/') && data
      ? itemFor(Number(target.split('/')[2].split('?')[0]), data)
      : undefined;
  if (item) {
    title = exoticPiece(item) ? item.name : editorName(item);
    kicker = exoticPiece(item) || undefined;
  }
  const location = useLocation();
  const globalRoute = target ?? `${location.pathname}${location.search}`;
  const globalName = /^\/t\/[123](?:\?|$)/.test(globalRoute)
    ? new URLSearchParams(globalRoute.split('?')[1]).get('global')
    : null;
  if (globalName) {
    title = globalName;
    kicker = undefined;
  }
  useAuthSession();
  const { summary, dataError } = useIdentity();
  const problem = summary.tone === 'error' || Boolean(dataError);
  const [sheet, setSheet] = useState<'workspaces' | 'finder' | 'account' | null>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const finderButton = useRef<HTMLButtonElement>(null);
  const close = () => setSheet(null);
  return (
    <header className={styles.header}>
      <button
        ref={menu}
        type="button"
        className={styles.mark}
        aria-haspopup="dialog"
        aria-expanded={sheet === 'workspaces'}
        aria-label={problem ? 'Workspaces, settings, and account (account problem)' : 'Workspaces'}
        onClick={() => setSheet((value) => (value === 'workspaces' ? null : 'workspaces'))}
      >
        <BrandMark />
        {problem && <span className={styles.alertDot} aria-hidden="true" />}
      </button>
      {hasFinder ? (
        <button
          ref={finderButton}
          data-tooltip-finder
          type="button"
          className={styles.title}
          aria-haspopup="dialog"
          aria-expanded={sheet === 'finder'}
          onClick={() => setSheet((value) => (value === 'finder' ? null : 'finder'))}
        >
          <span
            className={kicker ? undefined : styles.twoLines}
            style={{ '--title-em': titleWidthEm(title) } as CSSProperties}
          >
            {kicker && <span className={styles.kicker}>{kicker}</span>}
            {title}
          </span>
          <span className={styles.chevron} aria-hidden="true" />
        </button>
      ) : (
        <h1 className={styles.title}>
          <span
            className={styles.twoLines}
            style={{ '--title-em': titleWidthEm(title) } as CSSProperties}
          >
            {title}
          </span>
        </h1>
      )}
      <div className={styles.end}>
        <DraftButton iconOnly />
      </div>
      <ShellOverlay
        open={sheet === 'workspaces'}
        onClose={close}
        label="Workspaces"
        anchorRef={menu}
      >
        <WorkspaceList
          user={user}
          pathname={pathname}
          routeFor={routeFor}
          onNavigate={close}
          onSettings={() => {
            close();
            useSettingsPanel.getState().show(menu.current);
          }}
          onAccount={() => setSheet('account')}
        />
      </ShellOverlay>
      <AccountSheet open={sheet === 'account'} onClose={close} anchorRef={menu} />
      {hasFinder && (
        <ShellOverlay
          open={sheet === 'finder'}
          onClose={close}
          label="Find"
          anchorRef={finderButton}
          keepMounted
          tall
        >
          <FinderSheetContext.Provider value={sheet === 'finder'}>
            <FinderSheetCloseContext.Provider value={close}>
              {finder}
            </FinderSheetCloseContext.Provider>
          </FinderSheetContext.Provider>
        </ShellOverlay>
      )}
      {overlay}
    </header>
  );
}
