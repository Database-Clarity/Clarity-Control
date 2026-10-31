import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeWeaponTypeLabels } from '@clarity/core';
import { loadGenerator } from './generator';

const item = { hash: 1, name: 'Perk', icon: '', categoryId: 'perk', inGameDescription: '' };

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

describe('generator catalog weapon-type labels', () => {
  it('uses the English defaults when weaponTypes.json is absent (404)', async () => {
    const urls = stubFetch(() => new Response('Not Found', { status: 404 }));
    const catalog = await loadGenerator();
    expect(urls.some((url) => url.endsWith('/templates/v2/weaponTypes.json'))).toBe(true);
    expect(catalog.weaponTypeLabels).toEqual(completeWeaponTypeLabels());
    expect(catalog.weaponTypeLabels['Hand Cannon']).toEqual({ en: 'Hand Cannon' });
    expect(Object.keys(catalog.items)).toEqual(['1']);
  });

  it('merges a present table over the defaults', async () => {
    stubFetch(() => Response.json({ 'Hand Cannon': { en: 'Hand Cannon', de: 'Handfeuerwaffe' } }));
    const { weaponTypeLabels } = await loadGenerator();
    expect(weaponTypeLabels['Hand Cannon']).toEqual({ en: 'Hand Cannon', de: 'Handfeuerwaffe' });
    expect(weaponTypeLabels.Sword).toEqual({ en: 'Sword' });
  });

  it('fails like the other catalog files on other errors and on a malformed table', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));
    await expect(loadGenerator()).rejects.toThrow('HTTP 500');
    stubFetch(() => Response.json({ Sword: { de: 'Schwert' } }));
    await expect(loadGenerator()).rejects.toThrow();
  });
});
