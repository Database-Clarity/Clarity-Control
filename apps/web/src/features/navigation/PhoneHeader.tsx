import { useRef, useState, type ReactNode } from 'react';
import type { User } from '../../services/api';
import { BrandMark } from './Brand';
import { DraftButton } from './DraftButton';
import { IdentityMenu } from './IdentityMenu';
import { SettingsButton } from './SettingsButton';
import { ShellOverlay } from './ShellOverlay';
import { FinderSheetCloseContext, FinderSheetContext } from './FinderSheetContext';
import { WorkspaceList } from './WorkspaceTabs';
import { useSteppingActivity } from './steppingActivity';
import { useDataStore } from '../../stores/data';
import { editorName, exoticPiece, itemFor } from './catalog';
import styles from './PhoneHeader.module.scss';

/**
 * Phone header (<= 700px), 48px, every control a 44px target: the mark opens the workspaces
 * sheet, the title opens the finder sheet (or just names the page where there is no finder),
 * then drafts and the account. Sheets replace the desktop popovers; the finder sheet stays
 * mounted while closed because the stepping listeners live in it.
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
  user: Pick<User, 'role'> | null | undefined;
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
  const [sheet, setSheet] = useState<'workspaces' | 'finder' | null>(null);
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
        aria-label="Workspaces"
        onClick={() => setSheet((value) => (value === 'workspaces' ? null : 'workspaces'))}
      >
        <BrandMark />
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
          <span>
            {kicker && <span className={styles.kicker}>{kicker}</span>}
            {title}
          </span>
          <span className={styles.chevron} aria-hidden="true" />
        </button>
      ) : (
        <h1 className={styles.title}>
          <span>{title}</span>
        </h1>
      )}
      <div className={styles.end}>
        <DraftButton iconOnly />
        <SettingsButton />
        <IdentityMenu />
      </div>
      <ShellOverlay
        open={sheet === 'workspaces'}
        onClose={close}
        label="Workspaces"
        anchorRef={menu}
      >
        <WorkspaceList user={user} pathname={pathname} routeFor={routeFor} onNavigate={close} />
      </ShellOverlay>
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
