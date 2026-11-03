import type { ReactNode } from 'react';
import type { User } from '../../services/api';
import { compactQuery, useMedia } from '../../ui/useMedia';
import { Brand } from './Brand';
import { DraftButton } from './DraftButton';
import { IdentityMenu } from './IdentityMenu';
import { WorkspaceTabs } from './WorkspaceTabs';
import styles from './Header.module.scss';

/**
 * The desktop header, 36px: lockup, workspace tabs for the role, the workspace's finder, drafts,
 * identity. Below 1100px the finder drops to its own 32px band under the bar so the tabs keep
 * their room. The phone has its own header (PhoneHeader).
 */
export function Header({
  user,
  pathname,
  routeFor,
  finder,
  overlay,
}: {
  user: Pick<User, 'role'> | null | undefined;
  pathname: string;
  routeFor(to: string): string;
  /** The finder slot content; rendered in the bar, or in the band when compact. */
  finder: ReactNode;
  /** Notices that hang from the header's lower edge without taking space. */
  overlay?: ReactNode;
}) {
  const compact = useMedia(compactQuery);
  return (
    <header className={styles.header} data-compact={compact || undefined}>
      <div className={styles.bar}>
        <Brand className={styles.brand} compact={compact} />
        <WorkspaceTabs user={user} pathname={pathname} routeFor={routeFor} />
        {!compact && <div className={styles.finder}>{finder}</div>}
        <div className={styles.end}>
          <DraftButton />
          <IdentityMenu />
        </div>
      </div>
      {compact && <div className={`${styles.finder} ${styles.band}`}>{finder}</div>}
      {overlay}
    </header>
  );
}
