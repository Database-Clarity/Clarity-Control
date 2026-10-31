import { useEffect } from 'react';
import { useAuthStore } from '../../stores/auth';
import { apiUrl } from '../../services/api';
import { useCompendiumStore } from './store';
import styles from './Compendium.module.scss';

export function CompendiumFreshness({ staleOnly = false }: { staleOnly?: boolean }) {
  const { data, error, refreshing, refreshMessage, load, refresh } = useCompendiumStore();
  const user = useAuthStore((state) => state.user);
  useEffect(() => {
    void load();
  }, [load]);
  const age = data ? Math.max(0, Date.now() - Date.parse(data.fetchedAt)) : null;
  if (staleOnly && age !== null && age <= 60 * 60_000 && !refreshing && !error) return null;
  return (
    <section aria-label="Compendium freshness">
      {data && (
        <p>
          Source fetched {new Date(data.fetchedAt).toLocaleString()} (
          {age !== null && age >= 60 * 60_000
            ? `${Math.floor(age / 3600_000)} hours old`
            : 'less than an hour old'}
          ). Unchanged successful refreshes keep this timestamp.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!!apiUrl && user?.role && ['editor', 'maintainer'].includes(user.role) && (
        <button type="button" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing && <span className={styles.spinner} aria-hidden="true" />}
          {refreshing ? 'Refreshing Compendium...' : 'Refresh Compendium'}
        </button>
      )}
      {refreshMessage && <p role="status">{refreshMessage}</p>}
    </section>
  );
}
