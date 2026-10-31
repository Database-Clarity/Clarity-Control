import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGenerator } from './generator';

const item = {
  hash: 1,
  name: 'Perk',
  icon: '',
  categoryId: 'perk',
  inGameDescription: '',
  owners: [2, 3],
  weaponTypes: ['Sword'],
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
    expect(catalog.items[1]).not.toHaveProperty('weaponTypes');
  });
});
