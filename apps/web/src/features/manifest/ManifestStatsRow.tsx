import { useEffect, useMemo } from 'react';
import type { Lang } from '@clarity/core';
import { compareStats, loadManifestStats, useManifestStats } from './manifestStats';
import { useLocalisedManifest } from './localisedManifest';
import styles from './ManifestTextRow.module.scss';

const amount = (stat: { value: number } | undefined) =>
  stat ? `${stat.value > 0 ? '+' : ''}${stat.value}` : '—';
export function ManifestStatsRow({
  hash,
  enhancedHash,
  lang,
}: {
  hash: number;
  enhancedHash?: number;
  lang: Lang;
}) {
  const stats = useManifestStats();
  const localised = useLocalisedManifest(lang);
  useEffect(() => {
    void loadManifestStats();
  }, []);
  const rows = useMemo(
    () =>
      compareStats(
        stats?.items[hash],
        enhancedHash === undefined ? undefined : (stats?.items[enhancedHash] ?? []),
      ),
    [stats, hash, enhancedHash],
  );
  if (!rows.length) return null;
  return (
    <div className={styles.stats} aria-label="Manifest stats">
      {rows.map(({ hash: stat, before, after, paired }) => {
        const changed =
          paired && (before?.value !== after?.value || before?.conditional !== after?.conditional);
        const value = (side: typeof before) => (
          <>
            {amount(side)}
            {side?.conditional && <span className={styles.conditional}> (conditional)</span>}
          </>
        );
        return (
          <span key={stat}>
            {localised?.statNames?.[stat]?.trim() || stats?.names[stat] || stat} {value(before)}
            {changed && (
              <>
                {' '}
                → <span className={styles.enhanced}>{value(after)}</span>
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}
