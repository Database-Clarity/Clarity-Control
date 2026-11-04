import { expect, it } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { GuidancePersistence } from './guidancePersistence';

it.each([false, true])(
  'keeps renewal in memory, backing up original bytes only on an authored edit (backup failure: %s)',
  async (fail) => {
    const f = guidedFixture();
    f.categories[0].entries[0].sampleEvidence += ' changed';
    const cache = new Map<string, string>();
    const key = `clarity-review-guidance:v1:${encodeURIComponent(f.scope)}`;
    const original = JSON.stringify({ document: f.document, revision: null, pending: true });
    cache.set(key, original);
    const storage = {
      getItem: (k: string) => cache.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (fail && k.includes(':pre-renewal:')) throw new Error('quota');
        cache.set(k, v);
      },
    };
    const request = async () => {
      throw new Error('offline');
    };
    const owner = new GuidancePersistence(f.scope, '/guidance', storage, request as typeof fetch);
    await owner.start();
    const revision = owner.getSnapshot().planningRevision;
    expect(owner.renew(f.categories, f.source, 'new')).toBe(true);
    expect(cache.get(key)).toBe(original);
    expect(cache.size).toBe(1);
    expect(owner.getSnapshot().renewalNotice).toBe('4 references carried over, 1 need re-check');
    expect(
      owner.getSnapshot().document.categories[f.categories[0].id].references![100].baseline,
    ).toBe(f.baseline);
    expect(owner.getSnapshot().planningRevision).toBeGreaterThan(revision);
    owner.comment(f.categories[0].id, 'An explicit owner edit');
    if (fail) {
      expect(cache.get(key)).toBe(original);
      expect(owner.getSnapshot().localError).toContain('quota');
    } else {
      const backup = [...cache.entries()].find(([k]) => k.includes(':pre-renewal:'))!;
      expect(backup[1]).toBe(original);
      expect(owner.renew(f.categories, f.source, 'new')).toBe(true);
      expect([...cache.keys()].filter((k) => k.includes(':pre-renewal:'))).toHaveLength(1);
    }
    owner.dispose();
  },
);
