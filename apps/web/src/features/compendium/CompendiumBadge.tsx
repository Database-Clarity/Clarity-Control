import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { useCompendiumStore } from './store';
import { compendiumChanges } from './tracking';
import styles from './Compendium.module.scss';

export function CompendiumBadge() {
  const tooltips = useDataStore((state) => state.data?.bundle.tooltips);
  const { data, error, load } = useCompendiumStore();
  useEffect(() => {
    void load();
  }, [load]);
  const count = useMemo(
    () => (tooltips && data ? compendiumChanges(tooltips, data).length : null),
    [tooltips, data],
  );
  return (
    <Link to="/compendium">
      Compendium{' '}
      <span
        className={styles.badge}
        aria-label={error ? 'Compendium unavailable' : `${count ?? 'Loading'} Compendium changes`}
      >
        {error ? '!' : (count ?? '...')}
      </span>
    </Link>
  );
}
