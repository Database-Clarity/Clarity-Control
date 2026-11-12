import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { identitySummary, useAuthSession } from '../../auth/AuthStatus';
import { useAuthStore } from '../../../stores/auth';
import { AccountPicture } from '../../navigation/AccountPicture';
import styles from '../../navigation/IdentityMenu.module.scss';

const loadSheet = () => import('./ReportIdentitySheet');
const ReportIdentitySheet = lazy(loadSheet);

export function ReportIdentityMenu() {
  useAuthSession();
  const { user, loading, error } = useAuthStore();
  const summary = identitySummary({ user, loading, error });
  const [open, setOpen] = useState(false);
  /** The sheet's code is fetched on first use, then stays mounted like before. */
  const [used, setUsed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { pathname, search } = useLocation();
  useEffect(() => setOpen(false), [pathname, search]);
  const pictured = summary.tone === 'ok' && user;
  const prefetch = () => void loadSheet().catch(() => undefined);
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
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={() => {
          setUsed(true);
          setOpen((value) => !value);
        }}
      >
        {pictured ? (
          <AccountPicture id={user.id} login={user.login} />
        ) : (
          <span className={styles.label}>{summary.label}</span>
        )}
      </button>
      {used && (
        <Suspense fallback={null}>
          <ReportIdentitySheet
            open={open}
            onClose={() => setOpen(false)}
            anchorRef={button}
            user={user}
            pictured={Boolean(pictured)}
          />
        </Suspense>
      )}
    </>
  );
}
