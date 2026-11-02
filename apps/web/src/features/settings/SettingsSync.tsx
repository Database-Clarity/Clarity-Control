import { useEffect } from 'react';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';

/** Switches the settings scope with the signed-in user and tries a sync when the tab hides. */
export function SettingsSync() {
  const loading = useAuthStore((state) => state.loading);
  const id = useAuthStore((state) => state.user?.id);
  const role = useAuthStore((state) => state.user?.role ?? null);
  useEffect(() => {
    if (loading) return;
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
