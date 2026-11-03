import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as parser from './parser-entry.ts';
import { buildCompendium, shrunkTabs } from './runner.mjs';
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
  it('records cell backgrounds, publishes a background-only change, and accepts data from before them', async () => {
    const first = await buildCompendium({ parser, load, now: '2026-10-27T00:00:00Z' });
    const backgrounds = (data) =>
      data.tabs.flatMap((tab) => tab.grid.map((entry) => entry.cell.background)).filter(Boolean);
    expect(backgrounds(first.data).length).toBeGreaterThan(0);
    // Data written before backgrounds existed still validates, and the first refresh adds them.
    const legacy = structuredClone(first.data);
    for (const tab of legacy.tabs) {
      for (const entry of tab.grid) delete entry.cell.background;
      for (const row of tab.rows) delete row.cell.background;
    }
    const upgraded = await buildCompendium({
      parser,
      load,
      previous: legacy,
      now: '2026-10-28T00:00:00Z',
    });
    expect(upgraded.changed).toBe(true);
    expect(backgrounds(upgraded.data)).toEqual(backgrounds(first.data));
    // Only a colour in the sheet changed: still new content, so it is committed.
    const recoloured = await buildCompendium({
      parser,
      previous: first.data,
      now: '2026-10-29T00:00:00Z',
      load: async (url) =>
        (await load(url)).replace(/background-color:#262c34/g, 'background-color:#123456'),
    });
    expect(recoloured.changed).toBe(true);
    expect(JSON.stringify(recoloured.data)).toContain('#123456');
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
describe('shrink guard', () => {
  it('rejects a refresh that drops a tracked tab sharply, but allows deliberate or small changes', async () => {
    const first = await buildCompendium({ parser, load, now: '2026-10-27T00:00:00Z' });
    const big = structuredClone(first.data);
    const template = big.tabs[0].rows[0];
    big.tabs[0].rows = Array.from({ length: 20 }, (_, index) => ({
      ...template,
      name: `Row ${index}`,
    }));
    // Fixtures hold fewer than 16 rows, so the refreshed tab is "sharply" smaller than 20.
    await expect(
      buildCompendium({ parser, load, previous: big, now: '2026-10-28T00:00:00Z' }),
    ).rejects.toThrow(/shrank sharply.*Weapon Perks/);
    const allowed = await buildCompendium({
      parser,
      load,
      previous: big,
      now: '2026-10-28T00:00:00Z',
      allowShrink: true,
    });
    expect(allowed.changed).toBe(true);
    const missingTab = structuredClone(big);
    missingTab.tabs.push({ ...big.tabs[0], gid: '999', name: 'Gone Tab' });
    await expect(
      buildCompendium({ parser, load, previous: missingTab, now: '2026-10-28T00:00:00Z' }),
    ).rejects.toThrow(/Gone Tab/);
    // Retired tab recreated under a new gid keeps its rows: not a shrink.
    const moved = { gid: '2', name: 'Armor Mods', rows: Array.from({ length: 12 }) };
    expect(shrunkTabs({ tabs: [moved] }, [{ ...moved, gid: '3' }])).toEqual([]);
    expect(shrunkTabs({ tabs: [moved] }, [{ ...moved, gid: '3', rows: [] }])).toEqual([
      'Armor Mods 12→0',
    ]);
    const tab = (rows) => ({ gid: '1', name: 'T', rows: Array.from({ length: rows }) });
    expect(shrunkTabs({ tabs: [tab(10)] }, [tab(8)])).toEqual([]);
    expect(shrunkTabs({ tabs: [tab(10)] }, [tab(7)])).toEqual(['T 10→7']);
    expect(shrunkTabs({ tabs: [tab(9)] }, [tab(1)])).toEqual([]);
    expect(shrunkTabs({ tabs: [tab(10)] }, [tab(30)])).toEqual([]);
  });
});
