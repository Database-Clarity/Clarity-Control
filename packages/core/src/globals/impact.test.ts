import { expect, it } from 'vitest';
import { calculateGlobalImpact } from './impact.js';
import type { GlobalImpactChange, GlobalImpactSnapshot } from './impactModel.js';
import type { Tooltip } from '../schemas.js';
import type { Lang } from '../languages.js';
import { exportLegacy } from '../exportLegacy.js';
import { descriptionConverter } from '../../../export/src/converter/descriptionConverter.js';
import { expandAliases } from '../../../export/src/converter/converterFunctions/expandAliases.js';
import type { IntermediatePerks } from '../../../export/src/converter/types.js';

const cell = (text: string) => ({ text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' });
const tooltip = (hash: number, en: string, de?: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: cell(en), ...(de === undefined ? {} : { de: cell(de) }) },
});
function snapshot(docs: Tooltip[], revision = 'source1'): GlobalImpactSnapshot {
  return {
    repository: 'editor-data',
    revision,
    mode: 'live',
    aliases: {},
    tooltips: Object.fromEntries(docs.map((v) => [v.hash, v])),
    types: Object.fromEntries(docs.map((v) => [v.hash, 'Weapon Perk'])),
  };
}
const change: GlobalImpactChange = {
  cause: { globalId: 'g_fixture0001', beforeRevision: 'r1', afterRevision: 'r2' },
  kind: 'variables',
  beforeName: 'damage',
  afterName: 'damage',
};
const impacted = (a: GlobalImpactSnapshot, b = a, changes = [change]) =>
  calculateGlobalImpact(a, b, changes, 'live');
const hashes = (result: ReturnType<typeof impacted>) => result.rows.map((row) => row.consumer.hash);

function liveRender(source: GlobalImpactSnapshot, hash: number, lang: Lang) {
  const catalog = Object.fromEntries(
    Object.entries(source.types).map(([hash, type]) => [hash, { name: hash, type }]),
  );
  const database = expandAliases(
    exportLegacy(
      Object.values(source.tooltips),
      0,
      catalog,
      source.aliases,
    ) as unknown as IntermediatePerks,
  );
  return JSON.parse(
    JSON.stringify(
      descriptionConverter({
        descriptionString: database[hash].editor[lang]!.main,
        editorType: 'main',
        language: lang,
        hash,
        database,
      }),
    ),
  );
}

it('records actual nested, global-export, aliased, multipart, archived, and cross-category consumers', () => {
  const archive = tooltip(43, 'import Outer from 51');
  archive.archive = {
    removedAt: '2026-01-02T00:00:00Z',
    lastSeen: { name: 'Archived', categoryId: 'armor-mod', manifestVersion: 'fixture' },
  };
  const before = snapshot([
    tooltip(1, 'export Shared (\n#damage\n)'),
    tooltip(2, 'var damage = 10'),
    tooltip(3, ''),
    tooltip(40, '#damage'),
    tooltip(41, 'import Shared from global'),
    tooltip(42, 'import Outer from 51'),
    archive,
    tooltip(50, 'export Outer (\nimport Shared from global\n)'),
    tooltip(52, 'No global here'),
  ]);
  before.aliases = { 51: { to: 50, kind: 'name' }, 60: { to: 42, kind: 'frame' } };
  before.tooltips[42].associated = [43];
  before.types = { ...before.types, 43: 'Armor Mod', 51: 'Weapon Perk', 60: 'Weapon Perk' };
  const after = structuredClone(before);
  after.revision = 'source2';
  after.tooltips[2].text.en!.text = 'var damage = 20';
  const result = impacted(before, after);
  expect(result.complete).toBe(true);
  expect(hashes(result)).toEqual([40, 41, 42, 43, 50]);
  const nested = result.rows.find((v) => v.consumer.hash === 42)!;
  expect(nested.before!.reads.imports).toEqual(
    expect.arrayContaining([
      { key: '51', hash: 50 },
      { key: 'global', hash: 1 },
    ]),
  );
  expect(nested.before!.rendered).toContain('10');
  expect(nested.after!.rendered).toContain('20');
});

it('unions missing variables, renamed targets, deleted cells, and multiple causes', () => {
  const before = snapshot([
    tooltip(2, 'var damage = 10'),
    tooltip(40, '#damage', '#damage'),
    tooltip(41, '#hit'),
  ]);
  const after = structuredClone(before);
  after.revision = 'source2';
  after.tooltips[2].text.en!.text = 'var hit = 20';
  delete after.tooltips[40].text.de;
  const renamed = { ...change, afterName: 'hit' };
  const result = impacted(before, after, [
    renamed,
    { ...renamed, cause: { ...change.cause, globalId: 'g_fixture0002' } },
  ]);
  expect(result.complete).toBe(true);
  expect(result.rows).toHaveLength(3);
  expect(result.rows.every((row) => row.causes.length === 2)).toBe(true);
  expect(result.rows.find((row) => row.consumer.lang === 'de')!.after).toBeNull();
  expect(hashes(result)).toContain(41);
});

it('retains conservative unused-title preparation and import reads within title bodies', () => {
  const before = snapshot([
    tooltip(2, 'var damage = 10'),
    tooltip(3, 'title Unused (\nimport Shared from global\n)'),
    tooltip(1, 'export Shared (\n#damage\n)'),
    tooltip(40, 'Plain'),
  ]);
  const result = impacted(before);
  expect(result.complete).toBe(true);
  expect(hashes(result)).toEqual([40]);
  expect(result.rows[0].before!.reads.imports).toContainEqual({ key: 'global', hash: 1 });
  const titleChange: GlobalImpactChange = {
    ...change,
    kind: 'titles',
    beforeName: 'Unused',
    afterName: 'Unused',
  };
  expect(impacted(before, before, [titleChange]).rows[0].reason).toBe('title-preparation');
});

it('follows the real conditional/native branch and still reads imports before conditions', () => {
  const before = snapshot([
    tooltip(2, 'var damage = 10'),
    tooltip(40, 'enhanced (\n#damage\n)\nBase'),
    tooltip(41, '{{Base}{#damage}}'),
    tooltip(42, 'enhanced (\nimport Shared from global\n)\nBase'),
    tooltip(1, 'export Shared (\n#damage\n)'),
  ]);
  before.types = { ...before.types, 40: 'Weapon Trait Enhanced', 41: 'Weapon Trait Enhanced' };
  const result = impacted(before);
  expect(result.complete).toBe(true);
  expect(hashes(result)).toContain(40);
  expect(hashes(result)).toContain(41);
  expect(hashes(result)).not.toContain(42);
});

it('uses live English fallback for both consumer text and global/import libraries without inventing absent languages', () => {
  const vars = tooltip(2, 'var damage = 10', 'var damage = 5');
  const consumer = tooltip(40, '#damage', 'Alt');
  for (const doc of [vars, consumer]) {
    doc.text.en!.updatedAt = '2026-10-01T00:00:00Z';
    doc.text.de!.sourceUpdatedAt = '2026-01-01T00:00:00Z';
  }
  const before = snapshot([vars, consumer, tooltip(41, '#damage')]);
  const result = impacted(before, before, [{ ...change, languages: ['en'] }]);
  expect(result.complete).toBe(true);
  expect(result.rows.filter((v) => v.consumer.lang === 'de')).toHaveLength(1);
  expect(result.rows.find((v) => v.consumer.lang === 'de')!.before!.rendered).toContain('10');
  expect(impacted(before, before, [{ ...change, languages: ['de'] }]).rows).toHaveLength(0);
});

it('fails closed for cycles, missing import targets, aliases, and missing provenance', () => {
  const before = snapshot([
    tooltip(2, 'var damage = 10'),
    tooltip(40, 'import main from 41'),
    tooltip(41, 'import main from 40'),
    tooltip(42, 'import Shared from 999'),
  ]);
  const cycle = impacted(before);
  expect(cycle.complete).toBe(false);
  expect(cycle.blockers.join(' ')).toContain('five passes');
  expect(cycle.rows.every((row) => row.reason === 'unproven')).toBe(true);
  const missing = snapshot([tooltip(40, 'Plain')]);
  missing.repository = '';
  expect(impacted(missing).complete).toBe(false);
  const type = snapshot([tooltip(40, 'Plain')]);
  type.types = {};
  expect(impacted(type).blockers.join(' ')).toContain('type provenance');
  type.aliases = { 50: { to: 51, kind: 'name' }, 51: { to: 50, kind: 'name' } };
  expect(impacted(type).blockers.join(' ')).toContain('Cyclic');
});

it('blocks unreviewable alias-specific conditional renders and missing alias type provenance', () => {
  const before = snapshot([
    tooltip(2, 'var damage = 10'),
    tooltip(3, ''),
    tooltip(100, 'enhanced (\n#damage\n)\nBase'),
  ]);
  before.aliases = { 101: { to: 100, kind: 'frame' } };
  before.types = { ...before.types, 100: 'Weapon Trait', 101: 'Weapon Trait Enhanced' };
  const after = structuredClone(before);
  after.revision = 'source2';
  after.tooltips[2].text.en!.text = 'var damage = 20';
  expect(JSON.stringify(liveRender(before, 101, 'en'))).toContain('10');
  expect(JSON.stringify(liveRender(after, 101, 'en'))).toContain('20');
  const result = impacted(before, after);
  expect(result.complete).toBe(false);
  expect(result.blockers.join(' ')).toContain('Alias-specific render context');
  expect(result.rows.find((row) => row.consumer.hash === 100)!.reason).toBe('unproven');
  before.types = { ...before.types };
  Reflect.deleteProperty(before.types, '101');
  expect(impacted(before).blockers.join(' ')).toContain('Missing alias converter type provenance');
});

it('matches actual converter decimals for fallback, identical translations, and different translated inputs', () => {
  for (const translated of ['Alt', '#damage', '#damage DE']) {
    const consumer = tooltip(100, '#damage', translated);
    if (translated === 'Alt') {
      consumer.text.en!.updatedAt = '2026-10-01T00:00:00Z';
      consumer.text.de!.sourceUpdatedAt = '2026-01-01T00:00:00Z';
    }
    const before = snapshot([
      tooltip(2, 'var damage = 10.5', 'var damage = 10.5'),
      tooltip(3, '', ''),
      consumer,
    ]);
    const after = structuredClone(before);
    after.revision = 'source2';
    after.tooltips[2].text.en!.text = 'var damage = 20.5';
    after.tooltips[2].text.de!.text = 'var damage = 20.5';
    const result = impacted(before, after);
    expect(result.complete).toBe(true);
    const german = result.rows.find((row) => row.consumer.lang === 'de')!;
    expect(JSON.parse(german.before!.rendered)).toEqual(liveRender(before, 100, 'de'));
    expect(JSON.parse(german.after!.rendered)).toEqual(liveRender(after, 100, 'de'));
    expect(german.before!.rendered).toContain(translated === '#damage DE' ? '10,5' : '10.5');
  }
});
