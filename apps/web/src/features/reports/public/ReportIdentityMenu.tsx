import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { identitySummary, IdentityStatus, useAuthSession } from '../../auth/AuthStatus';
import { useAuthStore } from '../../../stores/auth';
import { AccountPicture } from '../../navigation/AccountPicture';
import { ShellOverlay } from '../../navigation/ShellOverlay';
import { MyReportsEntry } from './MyReportsEntry';
import styles from '../../navigation/IdentityMenu.module.scss';

export function ReportIdentityMenu() {
  useAuthSession();
  const { user, loading, error } = useAuthStore();
  const summary = identitySummary({ user, loading, error });
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
        style={{ maxWidth: 'none' }}
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
      <ShellOverlay
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={button}
        label="Account"
        width={320}
        align="end"
      >
        <div className={styles.menu}>
          <IdentityStatus
            onAction={() => setOpen(false)}
            accountRows={
              open && user ? <MyReportsEntry onNavigate={() => setOpen(false)} /> : undefined
            }
            picture={
              pictured ? <AccountPicture id={user.id} login={user.login} size="large" /> : undefined
            }
          />
        </div>
      </ShellOverlay>
    </>
  );
}
