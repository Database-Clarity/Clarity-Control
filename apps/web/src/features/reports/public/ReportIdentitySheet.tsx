import { useLayoutEffect, useRef, type RefObject } from 'react';
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
   * The sheet restores focus itself (the overlay's own restore is off). That restore runs in a
   * passive effect, which Preact (the public build) defers past a paint, so focus sat on the page
   * body for a frame after Escape; and it always took focus back, even from a field the reporter
   * had just pressed or another overlay that took over. Here focus goes to the account button only
   * while it is still in the sheet or was lost with it (the body): when the sheet closes, at once
   * in the layout pass, and once more after an outside press has settled where it lands.
   */
  const restore = () => {
    const anchor = anchorRef.current;
    const active = document.activeElement;
    if (!anchor?.isConnected || anchor.closest('[inert]')) return;
    if (active && active !== document.body && !active.closest('[data-shell-overlay="Account"]'))
      return;
    anchor.focus({ preventScroll: true });
  };
  const close = () => {
    restore();
    onClose();
    setTimeout(restore, 0);
  };
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) restore();
    wasOpen.current = open;
  });
  return (
    <ShellOverlay
      open={open}
      onClose={close}
      anchorRef={anchorRef}
      label="Account"
      restoreFocus={false}
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
