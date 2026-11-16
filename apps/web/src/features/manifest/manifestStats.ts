import { useSyncExternalStore } from 'react';

export type InvestmentStat = readonly [hash: number, value: number, conditional: boolean];
export interface ManifestStats {
  items: Record<string, readonly InvestmentStat[]>;
  names: Record<string, string>;
}
export function sumStats(stats: readonly InvestmentStat[] = []) {
  const sums = new Map<number, { value: number; conditional: boolean }>();
  for (const [hash, value, conditional] of stats) {
    const previous = sums.get(hash);
    sums.set(hash, {
      value: (previous?.value ?? 0) + value,
      conditional: !!previous?.conditional || conditional,
    });
  }
  for (const [hash, stat] of sums) if (stat.value === 0) sums.delete(hash);
  return sums;
}
export function compareStats(
  base: readonly InvestmentStat[] = [],
  enhanced?: readonly InvestmentStat[],
) {
  const before = sumStats(base),
    after = sumStats(enhanced);
  return [...new Set([...before.keys(), ...after.keys()])].map((hash) => ({
    hash,
    before: before.get(hash),
    after: after.get(hash),
    paired: enhanced !== undefined,
  }));
}
let loaded: ManifestStats | undefined;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
export function loadManifestStats() {
  pending ??= import('./investment-stats.json')
    .then((m) => {
      loaded = m.default as unknown as ManifestStats;
    })
    .catch(() => {
      loaded = { items: {}, names: {} };
    })
    .then(() => {
      for (const listener of listeners) listener();
    });
  return pending;
}
export function useManifestStats() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => loaded,
    () => undefined,
  );
}
