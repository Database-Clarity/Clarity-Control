// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { compareStats, loadManifestStats, sumStats, type ManifestStats } from './manifestStats';
import { ManifestStatsRow } from './ManifestStatsRow';
import { useNamesStore } from '../terms/names';

describe('manifest stats', () => {
  it('sums repeated stat hashes, omits zero sums, and preserves conditional marks', () => {
    expect([
      ...sumStats([
        [1, 10, false],
        [1, 5, true],
        [2, 5, false],
        [2, -5, false],
      ]),
    ]).toEqual([[1, { value: 15, conditional: true }]]);
  });
  it('compares changed, unchanged, and one-sided stats without treating missing as zero', () => {
    const rows = compareStats(
      [
        [1, 10, false],
        [2, 5, true],
        [3, 7, false],
      ],
      [
        [1, 15, false],
        [3, 7, false],
        [4, 9, false],
      ],
    );
    expect(rows).toMatchObject([
      { hash: 1, before: { value: 10 }, after: { value: 15 }, paired: true },
      { hash: 2, before: { value: 5, conditional: true }, after: undefined },
      { hash: 3, before: { value: 7 }, after: { value: 7 } },
      { hash: 4, before: undefined, after: { value: 9 } },
    ]);
    expect(compareStats()).toEqual([]);
  });
  it('loads once, follows selections without stale stats, and leaves no empty block', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await loadManifestStats();
    const asset = (await import('./investment-stats.json')).default as unknown as ManifestStats;
    const [hash, stats] = Object.entries(asset.items).find(([, stats]) => sumStats(stats).size)!;
    const stat = stats[0][0];
    const host = document.createElement('div');
    const root = createRoot(host);
    const show = (hash: number, enhancedHash?: number) =>
      act(async () =>
        root.render(<ManifestStatsRow hash={hash} enhancedHash={enhancedHash} lang="en" />),
      );
    try {
      await show(Number(hash));
      expect(host.textContent).toContain(asset.names[String(stat) as keyof typeof asset.names]);
      await show(0);
      expect(host.innerHTML).toBe('');
      await show(0, Number(hash));
      expect(host.textContent).toContain('— →');
      await show(Number(hash), 0);
      expect(host.textContent).toContain('→ —');
      await show(0);
      expect(host.innerHTML).toBe('');
    } finally {
      await act(async () => root.unmount());
      useNamesStore.setState({ byLang: {} });
    }
  });
});
