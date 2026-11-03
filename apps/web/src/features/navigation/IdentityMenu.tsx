import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { identitySummary, IdentityStatus, useAuthSession } from '../auth/AuthStatus';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useSettingsPanel } from '../settings/panel';
import { ShellOverlay } from './ShellOverlay';
import styles from './IdentityMenu.module.scss';

/**
 * The identity button and its menu: account state, Settings, the data revision. The button is
 * the stable anchor: Settings opens from it and focus returns to it, even though the menu item
 * that opened Settings is gone by then. Owns the once-only login load.
 */
export function IdentityMenu() {
  useAuthSession();
  const { user, loading, error } = useAuthStore();
  const data = useDataStore((state) => state.data);
  const dataError = useDataStore((state) => state.error);
  const loadData = useDataStore((state) => state.load);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { pathname, search } = useLocation();
  useEffect(() => setOpen(false), [pathname, search]);
  const summary = identitySummary({ user, loading, error });
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.button}
        data-identity-button
        data-tone={summary.tone}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Account: ${summary.detail}`}
        title={summary.detail}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.label}>{summary.label}</span>
        {summary.tone === 'ok' && user?.role && <span className={styles.role}>{user.role}</span>}
      </button>
      <ShellOverlay
        open={open}
        onClose={close}
        label="Account"
        anchorRef={button}
        width={320}
        align="end"
      >
        <div className={styles.menu}>
          <IdentityStatus
            onAction={close}
            settings={
              <button
                type="button"
                data-autofocus
                aria-haspopup="dialog"
                onClick={() => {
                  close();
                  useSettingsPanel.getState().show(button.current);
                }}
              >
                Settings
              </button>
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
    </>
  );
}
