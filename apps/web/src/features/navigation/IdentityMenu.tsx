import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { identitySummary, IdentityStatus, useAuthSession } from '../auth/AuthStatus';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { ShellOverlay } from './ShellOverlay';
import { MyReportsEntry } from '../reports/public/MyReportsEntry';
import styles from './IdentityMenu.module.scss';
import { AccountPicture } from './AccountPicture';
export { AccountPicture, avatarUrl } from './AccountPicture';

/** The account state as the header and the Clarity menu show it. */
export function useIdentity() {
  const { user, loading, error } = useAuthStore();
  const dataError = useDataStore((state) => state.error);
  const summary = identitySummary({ user, loading, error });
  return { user, summary, dataError };
}

/**
 * The Account sheet (desktop popover, phone bottom sheet): account state, sign in or out, the
 * data revision. Opened by the header's account button, or on a phone by the Clarity menu's
 * account row (focus then returns to the mark).
 */
export function AccountSheet({
  open,
  onClose,
  anchorRef,
}: {
  open: boolean;
  onClose(): void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const { user, summary } = useIdentity();
  const data = useDataStore((state) => state.data);
  const dataError = useDataStore((state) => state.error);
  const loadData = useDataStore((state) => state.load);
  return (
    <ShellOverlay
      open={open}
      onClose={onClose}
      label="Account"
      anchorRef={anchorRef}
      width={320}
      align="end"
    >
      <div className={styles.menu}>
        <IdentityStatus
          onAction={onClose}
          accountRows={open && user ? <MyReportsEntry onNavigate={onClose} /> : undefined}
          picture={
            summary.tone === 'ok' && user ? (
              <AccountPicture id={user.id} login={user.login} size="large" />
            ) : undefined
          }
        />
        {dataError && (
          <div role="alert" data-note>
            <p>Cannot load editor data: {dataError}</p>
            <button type="button" onClick={() => void loadData()}>
              Retry data loading
            </button>
          </div>
        )}
        <p className={styles.revision}>
          {data ? `Data revision ${data.bundle.sourceCommit.slice(0, 8)}` : 'Data not loaded'}
        </p>
      </div>
    </ShellOverlay>
  );
}

/**
 * The header's account button and its sheet. Signed in it is the GitHub picture only (name and role
 * in its label, its title, and the sheet); signed out, checking, read-only, and a login problem keep
 * their text labels. Settings has its own gear button (SettingsButton). Owns the once-only login
 * load where it is mounted; the phone header loads it itself (the button is not in its bar).
 */
export function IdentityMenu() {
  useAuthSession();
  const { user, summary } = useIdentity();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { pathname, search } = useLocation();
  useEffect(() => setOpen(false), [pathname, search]);
  const pictured = summary.tone === 'ok' && user;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.button}
        data-identity-button
        data-picture={pictured ? '' : undefined}
        data-tone={summary.tone}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Account: ${summary.detail}`}
        title={summary.detail}
        onClick={() => setOpen((value) => !value)}
      >
        {pictured ? (
          <AccountPicture id={user.id} login={user.login} />
        ) : (
          <span className={styles.label}>{summary.label}</span>
        )}
      </button>
      <AccountSheet open={open} onClose={() => setOpen(false)} anchorRef={button} />
    </>
  );
}
