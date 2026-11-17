import { expect, it } from 'vitest';
import { database } from '../../test/helpers.js';
import { migrateLegacy } from '../migrateLegacy.js';
import { exportLegacy } from '../exportLegacy.js';
import { inventoryGlobals, projectGlobals } from '../globals/projection.js';
import type { GlobalImpactSnapshot } from '../globals/impactModel.js';
import type { Tooltip } from '../schemas.js';
import { composeGlobalRelease, planGlobalRelease } from './index.js';
import { descriptionConverter } from '../../../export/src/converter/descriptionConverter.js';
import { expandAliases } from '../../../export/src/converter/converterFunctions/expandAliases.js';
import type { IntermediatePerks } from '../../../export/src/converter/types.js';

it('reviews an alias context whose shared source releases without an alias global read', async () => {
  const tooltip = (hash: number, text: string): Tooltip => ({
    hash,
    associated: [],
    text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' } },
  });
  const baseline = [
    tooltip(2, 'var Damage = 10'),
    tooltip(3, ''),
    tooltip(40, 'enhanced (\n#Damage\n)\nOld shared text'),
  ];
  const published = inventoryGlobals(
    baseline.slice(0, 2),
    {
      repository: 'fixture',
      revision: 'r1',
      locate: (hash, lang) => ({ path: `${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => 'g_aliasclosure1',
  );
  const saved = structuredClone(published);
  saved.entries[0].revision = 'r2';
  saved.entries[0].definitions.en!.body = '20';
  const current = structuredClone(baseline);
  current[0].text.en!.text = 'var Damage = 20';
  current[2].text.en!.text = 'enhanced (\n#Damage\n)\nNew shared text';
  const aliases = { 41: { to: 40, kind: 'sandbox' as const } };
  const types = { 2: 'none', 3: 'none', 40: 'Weapon Trait Enhanced', 41: 'Weapon Perk Sandbox' };
  const facts = Object.fromEntries(
    Object.entries(types).map(([hash, type]) => [hash, { name: hash, type }]),
  );
  const snapshot = (docs: Tooltip[], mode: 'authored' | 'live'): GlobalImpactSnapshot => ({
    repository: 'fixture',
    revision: 'r1',
    mode,
    aliases,
    types,
    tooltips: Object.fromEntries(docs.map((doc) => [doc.hash, doc])),
  });
  const plans = await planGlobalRelease({
    saved,
    published,
    authored: snapshot(current, 'authored'),
    live: snapshot(baseline, 'live'),
    causes: [],
    destination: 'test',
  });
  const alias = plans[0].rows.find((row) => row.view.consumer.hash === 41)!;
  expect(alias).toBeDefined();
  expect(alias.view.before!.reads.variables).not.toContain('Damage');
  expect(alias.view.after!.reads.variables).not.toContain('Damage');
  expect(plans[0].hashes).toEqual([2, 3, 40]);
  const rendered = (docs: Tooltip[]) => {
    const database = expandAliases(
      exportLegacy(docs, 0, facts, aliases) as unknown as IntermediatePerks,
    );
    return JSON.parse(
      JSON.stringify(
        descriptionConverter({
          database,
          descriptionString: database[41].editor.en!.main,
          editorType: 'main',
          language: 'en',
          hash: 41,
        }),
      ),
    );
  };
  expect(JSON.parse(alias.view.before!.rendered)).toEqual(rendered(baseline));
  expect(JSON.parse(alias.view.after!.rendered)).toEqual(rendered(current));
  expect(alias.view.before!.rendered).toContain('Old shared text');
  expect(alias.view.after!.rendered).toContain('New shared text');
});

it('uses canonical sources for distinct alias contexts across authored, live, and prior snapshots', async () => {
  const tooltip = (hash: number, text: string): Tooltip => ({
    hash,
    associated: [],
    text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' } },
  });
  const docs = [
    tooltip(2, 'var Damage = 10'),
    tooltip(3, ''),
    tooltip(40, 'enhanced (\n#Damage\n)\nBase'),
    { ...tooltip(0, '#Damage'), custom: { name: 'Default perk', categoryId: 'none' } },
  ];
  let counter = 0;
  const published = inventoryGlobals(
    docs.slice(0, 2),
    {
      repository: 'fixture',
      revision: 'r1',
      locate: (hash, lang) => ({ path: `${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_aliasfixture${++counter}`,
  );
  const saved = structuredClone(published);
  saved.entries[0].definitions.en!.body = '20';
  saved.entries[0].revision = 'r2';
  const snapshot: GlobalImpactSnapshot = {
    repository: 'fixture',
    revision: 'r1',
    mode: 'authored',
    aliases: { 41: { to: 40, kind: 'frame' } },
    types: { 2: 'Test', 3: 'Test', 40: 'Weapon Trait', 41: 'Weapon Trait Enhanced' },
    tooltips: Object.fromEntries(docs.map((doc) => [doc.hash, doc])),
  };
  const input = {
    saved,
    published,
    authored: snapshot,
    live: { ...snapshot, mode: 'live' as const },
    priorAuthored: [
      {
        snapshot: structuredClone(snapshot),
        published: { ...snapshot, mode: 'live' as const },
        names: {},
      },
    ],
    causes: [],
    destination: 'test',
  };
  const plans = await planGlobalRelease(input);
  const alias = plans[0].rows.find((row) => row.view.consumer.hash === 41)!;
  expect(alias.beforeSource).toBe(docs[2].text.en!.text);
  expect(alias.afterSource).toBe(docs[2].text.en!.text);
  expect(alias.view.before!.rendered).toContain('10');
  expect(alias.view.after!.rendered).toContain('20');
  expect(plans[0].hashes).toContain(40);
  expect(plans[0].hashes).not.toContain(41);
  expect(plans[0].rows.find((row) => row.view.consumer.hash === 0)!.view.after!.rendered).toContain(
    '20',
  );
  const noAliases = structuredClone(input);
  noAliases.authored.aliases = {};
  noAliases.live.aliases = {};
  for (const prior of noAliases.priorAuthored) {
    prior.snapshot.aliases = {};
    prior.published.aliases = {};
  }
  const canonical = await planGlobalRelease(noAliases);
  // Changing the alias map necessarily changes the dependency digest. Every other part of
  // the non-alias review remains identical; exact old/new planner parity is checked separately.
  const content = (rows: (typeof plans)[number]['rows']) =>
    rows.map(({ dependencyDigest: _digest, ...row }) => {
      void _digest;
      return row;
    });
  expect(
    content(plans.flatMap((plan) => plan.rows.filter((row) => row.view.consumer.hash !== 41))),
  ).toEqual(content(canonical.flatMap((plan) => plan.rows)));
  delete input.authored.tooltips[40]; // The prior snapshot still proves the removed consumer.
  await expect(planGlobalRelease(input)).rejects.toThrow('Deleted consumer dependency');
});

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
