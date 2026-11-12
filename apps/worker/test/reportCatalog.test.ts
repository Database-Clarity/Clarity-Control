import { beforeAll, describe, expect, it, vi } from 'vitest';
const snapshot = vi.hoisted(() => ({ sha256: '', sourceCommit: 'a'.repeat(40) }));
vi.mock('../src/reportCatalogSnapshot.json', () => ({ default: snapshot }));
import { parseReportCatalog, reportCatalogEntry, reportDigest } from '../src/reports';
const items = {
  '123': { owner: 42, langs: ['en'], variant: 'enhanced' },
  '1234': { owner: 50, langs: ['de'], variant: 'override:50' },
};
const raw =
  JSON.stringify({
    v: 1,
    sourceCommit: snapshot.sourceCommit,
    generatorCommit: 'b'.repeat(40),
    items,
  }) + '\n';
beforeAll(async () => {
  snapshot.sha256 = await reportDigest(raw);
});
describe('exact-snapshot report catalog', () => {
  it('slices only the selected complete key from the validated snapshot', async () => {
    const catalog = await parseReportCatalog(raw);
    expect(catalog).toEqual({ text: raw });
    expect(reportCatalogEntry(catalog, 123)).toEqual(items[123]);
    expect(reportCatalogEntry(catalog, 1234)).toEqual(items[1234]);
    expect(reportCatalogEntry(catalog, 12)).toBeNull();
  });
  it('uses the original parser for every differing upstream revision', async () => {
    const catalog = await parseReportCatalog(
      JSON.stringify({
        sourceCommit: 'c'.repeat(40),
        items: { '123': { owner: 99, langs: ['en'], variant: 'base' } },
      }),
    );
    expect(catalog).not.toHaveProperty('text');
    expect(reportCatalogEntry(catalog, 123)).toEqual({ owner: 99, langs: ['en'], variant: 'base' });
  });
  it('rejects corrupt roots and invalid commits instead of treating them as snapshots', async () => {
    for (const text of [
      raw + 'x',
      JSON.stringify({ sourceCommit: 'invalid', items }),
      JSON.stringify({ sourceCommit: snapshot.sourceCommit, items: [] }),
    ])
      await expect(parseReportCatalog(text)).rejects.toThrow();
  });
});
