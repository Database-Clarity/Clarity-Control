import { describe, expect, it } from 'vitest';
import { removedFromManifest } from './index';
import { tooltipSchema, type Tooltip } from '../schemas';
const tooltip = (hash: number): Tooltip => ({ hash, text: {}, associated: [] });
const tracked = Array.from({ length: 100 }, (_, index) => tooltip(100 + index));
const items = Object.fromEntries(
  tracked.slice(1).map(({ hash }) => [hash, { categoryId: 'trait' }]),
);
describe('removedFromManifest', () => {
  it('lists absent hashes immediately without modifying records', () => {
    expect(removedFromManifest(tracked, items).removed).toEqual([tracked[0]]);
    expect(tracked[0].archive).toBeUndefined();
  });
  it('excludes custom, aliases of present items, enhanced members, inactive and globals', () => {
    const records = [
      ...tracked,
      { ...tooltip(300), custom: { name: 'Custom', categoryId: 'trait' } },
      tooltip(301),
      tooltip(302),
      tooltip(303),
      tooltip(2),
    ];
    const manifest = { ...items, 101: { categoryId: 'trait', enhancedHash: 302 } };
    expect(
      removedFromManifest(
        records,
        manifest,
        { 301: { to: 101, kind: 'sandbox' } },
        new Set([303]),
      ).removed.map((entry) => entry.hash),
    ).toEqual([100]);
  });
  it('still lists a manifest attachment switched to a custom category once it leaves the manifest', () => {
    const switched = {
      ...tooltip(150),
      custom: { name: 'Sight', categoryId: 'attachment-effect' },
    };
    const records = tracked.map((entry) => (entry.hash === 150 ? switched : entry));
    const gone = { ...items };
    delete gone[150];
    const result = removedFromManifest(records, gone);
    expect(result.removed.map((entry) => entry.hash)).toEqual([100, 150]);
    const confirmed = records.map((entry) =>
      entry.hash === 150
        ? {
            ...entry,
            archive: {
              removedAt: 'x',
              lastSeen: { name: 'Sight', categoryId: 'attachment-effect', manifestVersion: 'v1' },
            },
          }
        : entry,
    );
    expect(
      removedFromManifest(confirmed, {
        ...gone,
        150: { categoryId: 'attachment-effect' },
      }).returned.map((entry) => entry.hash),
    ).toEqual([150]);
  });
  it('pauses missing/empty/incomplete manifests, at strictly more than five percent', () => {
    const manifests: Parameters<typeof removedFromManifest>[1][] = [
      null,
      undefined,
      {},
      { 100: { categoryId: 'trait' } },
    ];
    for (const manifest of manifests) {
      expect(removedFromManifest(tracked, manifest)).toEqual({
        paused: true,
        removed: [],
        returned: [],
      });
    }
    const five = Object.fromEntries(
      tracked.slice(5).map(({ hash }) => [hash, { categoryId: 'trait' }]),
    );
    expect(removedFromManifest(tracked, five).removed).toHaveLength(5);
  });
  it('shows confirmed returns separately and retains strict schema and metadata', () => {
    const archive = {
      removedAt: '2026-11-02T00:00:00Z',
      lastSeen: { name: 'Old item', categoryId: 'trait', manifestVersion: 'v1' },
    };
    const record = tooltipSchema.parse({ ...tracked[1], archive });
    expect(removedFromManifest([record], items).returned).toEqual([record]);
    expect(
      tooltipSchema.safeParse({ ...record, archive: { ...archive, unexpected: true } }).success,
    ).toBe(false);
  });
});
