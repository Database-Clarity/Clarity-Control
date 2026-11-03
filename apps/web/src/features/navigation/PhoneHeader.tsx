import { useRef, useState, type ReactNode } from 'react';
import type { User } from '../../services/api';
import { BrandMark } from './Brand';
import { DraftButton } from './DraftButton';
import { IdentityMenu } from './IdentityMenu';
import { ShellOverlay } from './ShellOverlay';
import { FinderSheetContext } from './FinderSheetContext';
import { WorkspaceList } from './WorkspaceTabs';
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
  finder,
  hasFinder,
  overlay,
}: {
  user: Pick<User, 'role'> | null | undefined;
  pathname: string;
  routeFor(to: string): string;
  title: string;
  finder: ReactNode;
  /** Whether the current workspace has anything to find or browse. */
  hasFinder: boolean;
  /** Notices that hang from the header's lower edge without taking space. */
  overlay?: ReactNode;
}) {
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
          type="button"
          className={styles.title}
          aria-haspopup="dialog"
          aria-expanded={sheet === 'finder'}
          onClick={() => setSheet((value) => (value === 'finder' ? null : 'finder'))}
        >
          <span>{title}</span>
          <span className={styles.chevron} aria-hidden="true" />
        </button>
      ) : (
        <h1 className={styles.title}>
          <span>{title}</span>
        </h1>
      )}
      <div className={styles.end}>
        <DraftButton iconOnly />
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
            {finder}
          </FinderSheetContext.Provider>
        </ShellOverlay>
      )}
      {overlay}
    </header>
  );
}
