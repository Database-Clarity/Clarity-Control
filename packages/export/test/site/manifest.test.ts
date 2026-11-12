// The legacy job's Bungie manifest: inventory items and sandbox perks (set bonuses), or nothing.
import { afterEach, expect, test, vi } from 'vitest';
import { loadManifest } from '../../src/site/legacy-job.js';

const items = { 1: { displayProperties: { description: 'Item' } } };
const perks = { 17188254: { displayProperties: { description: 'Set bonus' } } };
const paths = {
  DestinyInventoryItemDefinition: '/items.json',
  DestinySandboxPerkDefinition: '/perks.json',
};

function stub(en: Record<string, string>, status: Record<string, number> = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const body =
      path === '/Platform/Destiny2/Manifest/'
        ? { Response: { version: 'v-1', jsonWorldComponentContentPaths: { en } } }
        : path === '/items.json'
          ? items
          : perks;
    return new Response(JSON.stringify(body), { status: status[path] ?? 200 });
  });
  return calls;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('loads inventory items and sandbox perks', async () => {
  stub(paths);
  expect(await loadManifest(undefined)).toEqual({
    version: 'v-1',
    inventoryItem: items,
    sandboxPerk: perks,
  });
});

test.each([
  ['no sandbox perk path', { DestinyInventoryItemDefinition: '/items.json' }, {}],
  ['a failed sandbox perk download', paths, { '/perks.json': 500 }],
])('fails as a whole on %s (3 tries)', async (_, en, status) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const calls = stub(en, status);
  expect(await loadManifest(undefined)).toBeUndefined();
  expect(calls.filter((path) => path === '/Platform/Destiny2/Manifest/')).toHaveLength(3);
});
