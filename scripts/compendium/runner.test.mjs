import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as parser from './parser-entry.ts';
import { buildCompendium } from './runner.mjs';
const fixture = (name) =>
  readFileSync(
    new URL(`../../packages/core/test/compendium/fixtures/${name}.html`, import.meta.url),
    'utf8',
  );
const landing =
  '<a href="?gid=1662574278">Weapon Perks</a><a href="?gid=1287885342">Armor Perks</a><a href="?gid=618967225">Arc</a>';
const source = {
  1662574278: fixture('weapon'),
  1287885342: fixture('armor'),
  618967225: fixture('arc'),
};
const load = async (url) =>
  new URL(url).searchParams.has('gid') ? source[new URL(url).searchParams.get('gid')] : landing;
describe('dependency-free Compendium publisher', () => {
  it('builds every tab, validates normalized runs and preserves fetchedAt on no content changes', async () => {
    const first = await buildCompendium({ parser, load, now: '2026-10-27T00:00:00Z' });
    expect(first.changed).toBe(true);
    expect(first.data.tabs).toHaveLength(3);
    expect(first.data.tabs[0].rows[0].name).toBe('Accelerated Heatsink');
    const again = await buildCompendium({
      parser,
      load,
      previous: first.data,
      now: '2026-10-28T00:00:00Z',
    });
    expect(again).toEqual({ changed: false, data: first.data });
    const changed = await buildCompendium({
      parser,
      previous: first.data,
      now: '2026-10-28T00:00:00Z',
      load: async (url) => (await load(url)).replace(/#cccccc/g, '#dd7e6b'),
    });
    expect(changed.changed).toBe(true);
    expect(changed.data.fetchedAt).toBe('2026-10-28T00:00:00Z');
  });
  it('fails the whole build on missing headers, a failed fetch, or invalid previous data', async () => {
    await expect(
      buildCompendium({ parser, load: async () => '<html>login required</html>' }),
    ).rejects.toThrow();
    await expect(
      buildCompendium({
        parser,
        load: async () => {
          throw new Error('HTTP 503');
        },
      }),
    ).rejects.toThrow('HTTP 503');
    await expect(buildCompendium({ parser, load, previous: { tabs: [] } })).rejects.toThrow();
  });
});
