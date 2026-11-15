import { afterEach, expect, it, vi } from 'vitest';
import { migrateLegacy, parseMarkup, publishableHash, type AliasGroups } from '@clarity/core';
import { database } from '../../../../packages/core/test/helpers';
import { tooltipImports } from './tooltipImports';
import { bundleSchema } from './bundleSchema';
import { itemSchema } from './generatorSchema';
import { withSandboxPicks, useDataStore, type EditorData } from '../stores/data';
import { canonicalHash, navigationGroups, variantHashes } from '../features/navigation/catalog';
import { tooltipTextSources } from '../features/editor/references';

const at = '2026-11-15T00:00:00Z';
const group = (members: number[], categoryId = 'weapon-trait') => ({
  members,
  kind: 'S' as const,
  basis: { name: 'Twin', categoryId },
  by: { id: '1', login: 'maintainer' },
  at,
});
const groups: AliasGroups = {
  version: 1,
  groups: { 10: group([10, 20]), 11: group([11, 21], 'weapon-trait-enhanced') },
  rejected: {},
};
function fixture(): EditorData {
  const item = (hash: number, baseHash?: number) =>
    itemSchema.parse({
      hash,
      name: 'Twin',
      icon: '',
      inGameDescription: 'Same text',
      categoryId: baseHash ? 'weapon-trait-enhanced' : 'weapon-trait',
      plugCategoryHash: 100,
      isEnhanced: baseHash !== undefined,
      exotic: false,
      baseHash,
    });
  return {
    categories: [{ id: 'weapon-trait', label: 'Traits', group: 'Weapons', order: 1 }],
    items: { 10: item(10), 20: item(20), 11: item(11, 10), 21: item(21, 20) },
    aliases: {},
    sandboxConflicts: {},
    bundle: bundleSchema.parse({
      sourceCommit: 'a'.repeat(40),
      generatedAt: at,
      tooltips: {
        10: {
          hash: 10,
          text: { en: { text: 'Canonical', updatedAt: at, updatedBy: '1' } },
          associated: [],
        },
      },
      permissions: { users: {} },
      pushed: {},
      aliasGroups: groups,
    }),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  useDataStore.setState({ status: 'idle', data: null, error: null });
});

it('preserves the real tooltip census and import lookup when group config is absent', () => {
  const tooltips = Object.fromEntries(
    migrateLegacy(database('intermediate')).map((t) => [t.hash, t]),
  );
  expect(Object.keys(tooltips)).toHaveLength(2761);
  const original = fixture();
  const bundle = bundleSchema.parse({ ...original.bundle, tooltips, aliasGroups: undefined });
  const data = withSandboxPicks({ ...original, bundle }, undefined);
  expect(data.aliases).toBe(original.aliases);
  const before = tooltipImports(tooltips, {}, 'en', original.aliases);
  const after = tooltipImports(data.bundle.tooltips, {}, 'en', data.aliases);
  for (const hash of Object.keys(tooltips)) expect(after[hash], hash).toBe(before[hash]);
});

it('loads the snapshot groups, routes member searches once, and preserves enhanced identity', () => {
  const data = withSandboxPicks(fixture(), undefined);
  expect(data.aliases).toEqual({ 20: { to: 10, kind: 'name' }, 21: { to: 11, kind: 'name' } });
  expect(canonicalHash(20, data)).toBe(10);
  expect(canonicalHash(21, data)).toBe(10);
  expect(variantHashes(10, data)).toEqual([10, 11]);
  expect(
    navigationGroups(data, '20').flatMap((g) =>
      g.sections.flatMap((s) => s.items.map((i) => i.hash)),
    ),
  ).toEqual([10]);
  expect(tooltipTextSources(data.bundle.tooltips, {}, data.aliases).textFor(20, 'en')).toEqual({
    hash: 10,
    text: 'Canonical',
  });
  expect(data.bundle.sourceCommit).toBe('a'.repeat(40));
});

it('recomposes from generated aliases on pick refresh, removal, and repeated refresh', async () => {
  const original = fixture();
  const grouped = withSandboxPicks(original, undefined);
  const pointers = {
    version: 1 as const,
    pointers: { 90: { to: 20, candidates: [20, 30], by: 1, at } },
  };
  const picked = withSandboxPicks(grouped, pointers, { 90: [20, 30] });
  expect(picked.aliases[90]).toEqual({ to: 10, kind: 'sandbox' });
  const refreshed = withSandboxPicks(picked, undefined);
  expect(refreshed.aliases).toEqual(grouped.aliases);
  expect(withSandboxPicks(refreshed, undefined).aliases).toEqual(grouped.aliases);
  const tooltip = original.bundle.tooltips[10]!;
  expect(await publishableHash(tooltip, refreshed.aliases)).toBe(
    await publishableHash(tooltip, grouped.aliases),
  );
  expect(await publishableHash(tooltip, grouped.aliases)).not.toBe(
    await publishableHash(tooltip, {}),
  );
  const restored = withSandboxPicks(
    { ...refreshed, bundle: { ...refreshed.bundle, aliasGroups: undefined } },
    undefined,
  );
  expect(restored.aliases).toEqual({});
});

it('preserves explicit flags, reports drift, and rejects malformed groups without fallback', () => {
  const data = fixture();
  expect(data.items[21]).toMatchObject({ isEnhanced: true, exotic: false });
  data.items[20] = { ...data.items[20]!, categoryId: 'armor-mod' };
  const drifted = withSandboxPicks(data, undefined);
  expect(drifted.aliases[20]).toBeUndefined();
  expect(drifted.aliasGroupIssues?.length).toBeGreaterThan(0);
  expect(() =>
    bundleSchema.parse({ ...data.bundle, aliasGroups: { ...groups, version: 2 } }),
  ).toThrow();
  expect(() => withSandboxPicks({ ...fixture(), sandboxConflicts: undefined }, undefined)).toThrow(
    'conflicts unavailable',
  );
});

it('renders nested and global imports through the real resolver, ignoring stale alias text', () => {
  const data = withSandboxPicks(fixture(), undefined);
  const tooltip = (hash: number, text: string) => ({
    hash,
    text: { en: { text, updatedAt: at, updatedBy: '1' } },
    associated: [],
  });
  const saved = {
    ...data.bundle.tooltips,
    1: tooltip(1, 'export Shared (\nimport main from 20\n)'),
    20: tooltip(20, 'Archived member must never render'),
    30: tooltip(30, 'import Shared from global'),
    40: tooltip(40, 'import main from 41'),
    41: tooltip(41, 'import main from 40'),
  };
  for (const lookupOnly of [false, true]) {
    const imports = tooltipImports(saved, {}, 'en', data.aliases, { lookupOnly });
    const render = (text: string) => parseMarkup(text, { imports, variables: '', titles: '' });
    const direct = render('import main from 20');
    expect(JSON.stringify(direct.lines)).toContain('Canonical');
    expect(JSON.stringify(render('import main from 30').lines)).toContain('Canonical');
    expect(JSON.stringify(direct)).not.toContain('Archived member');
    expect(render('import main from 40').diagnostics.length).toBeGreaterThan(0);
    expect(render('import main from 999').diagnostics.length).toBeGreaterThan(0);
  }
});

it('loads, reloads, fails closed, and restores through the real bundle and generator readers', async () => {
  const data = fixture();
  let malformed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/bundle.json'))
        return Response.json({ ...data.bundle, ...(malformed ? { aliasGroups: {} } : {}) });
      if (url.includes('/config/inactive.json')) return new Response('', { status: 404 });
      if (url.endsWith('/categories.json')) return Response.json(data.categories);
      if (url.endsWith('/items.json')) return Response.json(data.items);
      return Response.json({});
    }),
  );
  await useDataStore.getState().load();
  expect(useDataStore.getState().data?.aliases[20]).toEqual({ to: 10, kind: 'name' });
  await useDataStore.getState().load();
  expect(useDataStore.getState().data?.aliases[21]).toEqual({ to: 11, kind: 'name' });
  malformed = true;
  await useDataStore.getState().load();
  expect(useDataStore.getState().status).toBe('error');
  malformed = false;
  await useDataStore.getState().load();
  expect(useDataStore.getState().status).toBe('ready');
});
