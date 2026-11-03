import { useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';

/** Switches the settings scope with the signed-in user and tries a sync when the tab hides. */
export function SettingsSync() {
  const loading = useAuthStore((state) => state.loading);
  const id = useAuthStore((state) => state.user?.id);
  const role = useAuthStore((state) => state.user?.role ?? null);
  const activated = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (loading) return;
    // A reload of the same account (storage event, retry, permission save) must not re-activate:
    // that voids an in-flight sync and reads this visit's unsynced edits back as "recovered".
    const key = id === undefined ? 'signed-out' : `${id}:${role}`;
    if (activated.current === key) return;
    activated.current = key;
    void useSettingsStore.getState().activate(id === undefined ? null : { id, role });
  }, [loading, id, role]);
  useEffect(() => {
    // Best effort only: the persisted pending marker and the next-load prompt are the safety net.
    const hide = () => useSettingsStore.getState().syncOnHide();
    const visibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return null;
}
