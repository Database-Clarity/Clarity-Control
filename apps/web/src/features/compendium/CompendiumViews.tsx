import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDataStore } from '../../stores/data';
import { Segmented } from '../../ui/RightPane';
import { useCompendiumQueueStore } from './queueStore';
import { useCompendiumStore } from './store';
import { compendiumChanges } from './tracking';
import styles from './CompendiumQueue.module.scss';

const number = new Intl.NumberFormat('en');
/** A count joins its label once known; the switch keeps its place meanwhile. */
const counted = (label: string, count: number | undefined) =>
  count === undefined ? label : `${label} ${number.format(count)}`;

/** The Compendium page's two lists: entries to link, and links whose source changed. */
export function CompendiumViews() {
  const [params, setParams] = useSearchParams();
  const tooltips = useDataStore((state) => state.data?.bundle.tooltips);
  const source = useCompendiumStore((state) => state.data);
  const open = useCompendiumQueueStore((state) => (state.rows ? state.counts.open : undefined));
  const changes = useMemo(
    () => (tooltips && source ? compendiumChanges(tooltips, source).length : undefined),
    [tooltips, source],
  );
  const view = params.get('tab') === 'linked' ? 'linked' : 'review';
  return (
    <Segmented
      label="Compendium list"
      className={styles.views}
      value={view}
      options={[
        { value: 'review', label: counted('To review', open) },
        { value: 'linked', label: counted('Source changes', changes) },
      ]}
      onChange={(value) => {
        if (value === view) return;
        const next = new URLSearchParams(params);
        if (value === 'linked') next.set('tab', 'linked');
        else next.delete('tab');
        setParams(next);
      }}
    />
  );
}
