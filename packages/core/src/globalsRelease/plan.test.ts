import { expect, it } from 'vitest';
import { database } from '../../test/helpers.js';
import { migrateLegacy } from '../migrateLegacy.js';
import { exportLegacy } from '../exportLegacy.js';
import { inventoryGlobals, projectGlobals } from '../globals/projection.js';
import type { GlobalImpactSnapshot } from '../globals/impactModel.js';
import type { Tooltip } from '../schemas.js';
import { composeGlobalRelease, planGlobalRelease } from './index.js';

it('preserves the real immutable corpus and resolves its release closure through S1', async () => {
  const raw = database('live');
  const tooltips = Object.fromEntries(migrateLegacy(raw).map((tooltip) => [tooltip.hash, tooltip]));
  let id = 0;
  const published = inventoryGlobals(
    [tooltips[2], tooltips[3]],
    {
      repository: 'real-fixture',
      revision: 'baseline',
      locate: (hash, lang) => ({
        path: 'live.json',
        selector: ['perks', String(hash), 'editor', lang, 'main'],
      }),
    },
    () => `g_realfixture${++id}`,
  );
  const identical = composeGlobalRelease(published, published, []);
  expect(projectGlobals(identical)).toEqual(projectGlobals(published));
  expect(exportLegacy(Object.values({ ...tooltips, ...projectGlobals(identical) }), 0)).toEqual(
    exportLegacy(Object.values(tooltips), 0),
  );
  const saved = structuredClone(published);
  const changed = saved.entries.find((entry) => entry.name === 'GlobalTangleCooldown')!;
  changed.revision = 'counterfactual';
  changed.definitions.en!.revision = 'counterfactual';
  changed.definitions.en!.body = '999';
  const authored: GlobalImpactSnapshot = {
    repository: 'real-fixture',
    revision: 'candidate',
    mode: 'authored',
    tooltips,
    aliases: {},
    types: Object.fromEntries(Object.values(raw.perks).map((entry) => [entry.hash, entry.type])),
  };
  const plans = await planGlobalRelease({
    saved,
    published,
    authored,
    live: { ...authored, mode: 'live' },
    causes: [],
    destination: 'test',
  });
  expect(plans).toHaveLength(1);
  expect(plans[0].ids).toEqual([changed.id]);
  expect(plans[0].rows.length).toBeGreaterThan(0);
  expect(
    plans[0].rows.every((row) => row.view.causes.every((cause) => cause.globalId === changed.id)),
  ).toBe(true);
  expect(projectGlobals(plans[0].store)[2].text.en!.text).toContain(
    'var GlobalTangleCooldown = 999',
  );
}, 60_000);

it('joins globals through real nested/aliased resolver reads and rejects cycles or deleted imports', async () => {
  const tooltip = (hash: number, text: string): Tooltip => ({
    hash,
    associated: [],
    text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' } },
  });
  const docs = [
    tooltip(1, 'export Shared (\n#Alpha #Beta\n)'),
    tooltip(2, 'var Alpha = 10\nvar Beta = 20'),
    tooltip(3, ''),
    tooltip(40, 'import Nested from 51'),
    tooltip(50, 'export Nested (\nimport Shared from global\n)'),
  ];
  let id = 0;
  const published = inventoryGlobals(
    docs.filter((document) => document.hash === 2 || document.hash === 3),
    {
      repository: 'fixture',
      revision: 'baseline',
      locate: (hash, lang) => ({ path: `${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_fixture00${++id}`,
  );
  const saved = structuredClone(published);
  for (const entry of saved.entries) {
    entry.revision = 'changed';
    entry.definitions.en!.body = '999';
  }
  const documents = Object.fromEntries(docs.map((document) => [document.hash, document]));
  const authored: GlobalImpactSnapshot = {
    repository: 'fixture',
    revision: 'saved',
    tooltips: documents,
    aliases: { 51: { to: 50, kind: 'name' } },
    types: Object.fromEntries([
      ...docs.map((document) => [document.hash, 'Weapon Perk']),
      [51, 'Weapon Perk'],
    ]),
    mode: 'authored',
  };
  const input = {
    saved,
    published,
    authored,
    live: { ...authored, mode: 'live' as const },
    causes: [],
    destination: 'test',
  };
  const plans = await planGlobalRelease(input);
  expect(plans).toHaveLength(1);
  expect(plans[0].ids).toHaveLength(2);
  expect(plans[0].rows.some((row) => row.view.consumer.hash === 40)).toBe(true);
  authored.tooltips[50].text.en!.text = 'export Nested (\nimport Nested from 51\n)';
  await expect(planGlobalRelease(input)).rejects.toThrow('incomplete');
  delete documents[50];
  await expect(planGlobalRelease(input)).rejects.toThrow('incomplete');
});

it('includes readers of other exports when a required saved import source changes', async () => {
  const tooltip = (hash: number, text: string): Tooltip => ({
    hash,
    associated: [],
    text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' } },
  });
  const baseline = [
    tooltip(1, ''),
    tooltip(2, 'var Alpha = 10'),
    tooltip(3, ''),
    tooltip(40, 'import UsesAlpha from 50'),
    tooltip(50, 'export UsesAlpha (\n#Alpha\n)\nexport Other (\nOld other text\n)'),
    tooltip(60, 'import Other from 50'),
  ];
  let id = 0;
  const published = inventoryGlobals(
    baseline.filter((document) => document.hash === 2 || document.hash === 3),
    {
      repository: 'fixture',
      revision: 'baseline',
      locate: (hash, lang) => ({ path: `${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_importfixture${++id}`,
  );
  const saved = structuredClone(published);
  saved.entries[0].revision = 'changed';
  saved.entries[0].definitions.en!.body = '100';
  const current = structuredClone(baseline);
  current.find((document) => document.hash === 50)!.text.en!.text =
    'export UsesAlpha (\n#Alpha\n)\nexport Other (\nNew other text\n)';
  const common = {
    repository: 'fixture',
    revision: 'candidate',
    aliases: {},
    types: Object.fromEntries(baseline.map((document) => [document.hash, 'Weapon Perk'])),
  };
  const plans = await planGlobalRelease({
    saved,
    published,
    causes: [],
    destination: 'test',
    authored: {
      ...common,
      mode: 'authored',
      tooltips: Object.fromEntries(current.map((document) => [document.hash, document])),
    },
    live: {
      ...common,
      mode: 'live',
      tooltips: Object.fromEntries(baseline.map((document) => [document.hash, document])),
    },
  });
  expect(plans[0].rows.some((row) => row.view.consumer.hash === 60)).toBe(true);
  expect(plans[0].hashes).toContain(60);
});

it('reviews aggregate fallback effects on an unchanged translated variable', async () => {
  const cell = (text: string) => ({ text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' });
  const docs: Tooltip[] = [
    {
      hash: 2,
      associated: [],
      text: {
        en: cell('var Alpha = 10\nvar Beta = 20'),
        de: { ...cell('var Alpha = 1\nvar Beta = 2'), sourceUpdatedAt: '2026-01-01T00:00:00Z' },
      },
    },
    { hash: 3, associated: [], text: { en: cell('') } },
    { hash: 40, associated: [], text: { en: cell('#Alpha'), de: cell('#Alpha') } },
    { hash: 41, associated: [], text: { en: cell('#Beta'), de: cell('#Beta') } },
  ];
  let id = 0;
  const published = inventoryGlobals(
    docs.filter((document) => document.hash === 2 || document.hash === 3),
    {
      repository: 'fixture',
      revision: 'baseline',
      locate: (hash, lang) => ({ path: `${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_fallback${++id}000`,
  );
  const saved = structuredClone(published),
    alpha = saved.entries.find((entry) => entry.name === 'Alpha')!;
  alpha.revision = 'changed';
  alpha.definitions.en!.revision = 'changed';
  alpha.definitions.en!.body = '100';
  alpha.definitions.en!.updatedAt = '2026-11-01T00:00:00Z';
  const common = {
    repository: 'fixture',
    revision: 'candidate',
    aliases: {},
    tooltips: Object.fromEntries(docs.map((document) => [document.hash, document])),
    types: Object.fromEntries(docs.map((document) => [document.hash, 'Weapon Perk'])),
  };
  const plans = await planGlobalRelease({
    saved,
    published,
    causes: [],
    destination: 'test',
    authored: { ...common, mode: 'authored' },
    live: { ...common, mode: 'live' },
  });
  const beta = plans[0].rows.find(
    (row) => row.view.consumer.hash === 41 && row.view.consumer.lang === 'de',
  );
  expect(beta?.view.causes.map((cause) => cause.globalId)).toEqual([alpha.id]);
  expect(beta?.view.before?.rendered).not.toBe(beta?.view.after?.rendered);
});
