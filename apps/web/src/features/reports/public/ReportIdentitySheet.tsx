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
  /**
   * Focus goes back to the account button in the same step that closes the sheet. The overlay's
   * own restore runs in an effect, which Preact (the public build) defers past a paint, so focus
   * would sit on the page body for a frame after Escape. Only when focus is in the sheet: another
   * overlay taking over keeps its own focus.
   */
  const close = () => {
    const anchor = anchorRef.current;
    if (
      anchor?.isConnected &&
      !anchor.closest('[inert]') &&
      document.activeElement?.closest('[data-shell-overlay="Account"]')
    )
      anchor.focus({ preventScroll: true });
    onClose();
  };
  return (
    <ShellOverlay
      open={open}
      onClose={close}
      anchorRef={anchorRef}
      label="Account"
      width={320}
      align="end"
    >
      <div className={styles.menu}>
        <IdentityStatus
          onAction={close}
          accountRows={open && user ? <MyReportsEntry onNavigate={close} /> : undefined}
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
