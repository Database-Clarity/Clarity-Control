import { type ReactNode, useEffect, useMemo } from 'react';
import type { Lang } from '@clarity/core';
import { compareStats, loadManifestStats, useManifestStats } from './manifestStats';
import { useLocalisedManifest } from './localisedManifest';
import styles from './ManifestTextRow.module.scss';

const amount = (value: number) => `${value > 0 ? '+' : ''}${value}`;
const enhanced = (text: string) => <ins className={styles.enhanced}>{text}</ins>;

/**
 * The entry's manifest investment stats as an aligned list: name, then the value right-aligned in
 * its own column, then a "conditional" note. A pair diffs like the manifest text below it: an
 * unchanged value shows once, a base-only value is struck, an enhanced-only value is marked.
 */
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
    <dl className={styles.stats} aria-label="Manifest stats">
      {rows.map(({ hash: stat, before, after, paired }) => {
        const value =
          !paired || before?.value === after?.value ? (
            amount((before ?? after)!.value)
          ) : (
            <>
              {before && <del>{amount(before.value)}</del>}
              {before && after && ' '}
              {after && enhanced(amount(after.value))}
            </>
          );
        // A one-sided stat's note follows its value: struck or marked with it.
        let note: ReactNode = null;
        if (!paired || (before?.conditional && after?.conditional)) {
          if ((before ?? after)!.conditional) note = 'conditional';
        } else if (before?.conditional) note = <del>conditional</del>;
        else if (after?.conditional) note = enhanced('conditional');
        return (
          <div key={stat}>
            <dt>{localised?.statNames?.[stat]?.trim() || stats?.names[stat] || stat}</dt>
            <dd>{value}</dd>
            <dd>{note}</dd>
          </div>
        );
      })}
    </dl>
  );
}
