import type { RefObject } from 'react';
import { IdentityStatus } from '../../auth/AuthStatus';
import { AccountPicture } from '../../navigation/AccountPicture';
import { ShellOverlay } from '../../navigation/ShellOverlay';
import type { User } from '../../../services/api';
import { MyReportsEntry } from './MyReportsEntry';
import styles from '../../navigation/IdentityMenu.module.scss';

/**
 * The account sheet behind the public header's identity button. ReportIdentityMenu loads it on
 * first use (hover, focus, or press), so a direct link's first paint carries only the button.
 */
export default function ReportIdentitySheet({
  open,
  onClose,
  anchorRef,
  user,
  pictured,
}: {
  open: boolean;
  onClose(): void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  user: User | null;
  pictured: boolean;
}) {
  return (
    <ShellOverlay
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      label="Account"
      width={320}
      align="end"
    >
      <div className={styles.menu}>
        <IdentityStatus
          onAction={onClose}
          accountRows={open && user ? <MyReportsEntry onNavigate={onClose} /> : undefined}
          picture={
            pictured && user ? (
              <AccountPicture id={user.id} login={user.login} size="large" />
            ) : undefined
          }
        />
      </div>
    </ShellOverlay>
  );
}
