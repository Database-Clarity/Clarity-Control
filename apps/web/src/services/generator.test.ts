import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemSchema, loadGenerator } from './generator';

const item = {
  hash: 1,
  name: 'Perk',
  icon: '',
  categoryId: 'perk',
  inGameDescription: '',
  owners: [2, 3],
  ownerNames: { 2: 'Exotic A', 3: 'Exotic B' },
  weaponTypes: ['Sword'],
  plugCategoryHash: 20,
};

function stubFetch(weaponTypes: () => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/weaponTypes.json')) return weaponTypes();
      if (url.endsWith('/categories.json')) {
        return Response.json([{ id: 'perk', label: 'Perk', group: 'g', order: 1 }]);
      }
      if (url.endsWith('/items.json')) return Response.json({ 1: item });
      if (url.endsWith('/aliases.json')) return Response.json({});
      return new Response('unexpected', { status: 500 });
    }),
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe('generator catalog', () => {
  it('accepts old catalogs and rejects malformed owner-name metadata', () => {
    const oldItem = Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== 'ownerNames'),
    );
    expect(itemSchema.parse(oldItem).ownerNames).toBeUndefined();
    expect(itemSchema.parse({ ...oldItem, itemHash: 42, itemName: 'Exotic' }).itemName).toBe(
      'Exotic',
    );
    expect(() => itemSchema.parse({ ...item, ownerNames: { 2: 42 } })).toThrow();
  });
  it('preserves non-enhanced DIM provenance without creating an enhanced mapping', () => {
    const twin = itemSchema.parse({ ...item, dimBaseHash: 42 });
    expect(twin.dimBaseHash).toBe(42);
    expect(twin.baseHash).toBeUndefined();
    expect(twin.enhancedHash).toBeUndefined();
    expect(twin.enhancedHashes).toBeUndefined();
    expect(() => itemSchema.parse({ ...item, dimBaseHash: -1 })).toThrow();
  });
  it.each([
    () => new Response('missing', { status: 404 }),
    () => new Response('failure', { status: 500 }),
    () => Response.json({ Sword: { de: 'malformed retired labels' } }),
  ])('never requests the retired label service', async (labels) => {
    const urls = stubFetch(labels);
    const catalog = await loadGenerator();
    expect(urls).toHaveLength(3);
    expect(urls.some((url) => url.endsWith('/weaponTypes.json'))).toBe(false);
    expect(catalog).not.toHaveProperty('weaponTypeLabels');
    expect(Object.keys(catalog.items)).toEqual(['1']);
    expect(catalog.items[1].owners).toEqual([2, 3]);
    expect(catalog.items[1].ownerNames).toEqual({ 2: 'Exotic A', 3: 'Exotic B' });
    expect(catalog.items[1]).not.toHaveProperty('weaponTypes');
    expect(catalog.items[1].plugCategoryHash).toBe(20);
  });
});
