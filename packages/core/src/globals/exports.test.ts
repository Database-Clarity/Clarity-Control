import { expect, it } from 'vitest';
import type { Tooltip } from '../schemas.js';
import { exportLegacy } from '../exportLegacy.js';
import { calculateGlobalImpact } from './impact.js';
import type { GlobalImpactSnapshot } from './impactModel.js';
import { globalRecordSchema, validGlobalName } from './model.js';
import { inventoryGlobals, projectGlobals } from './projection.js';
import { rewriteGlobalReferences } from './references.js';
import { assertGlobalTransition } from './transition.js';
import { composeGlobalRelease, planGlobalRelease } from '../globalsRelease/index.js';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' } },
});
const inventory = (documents: Tooltip[]) => {
  let id = 0;
  return inventoryGlobals(
    documents,
    {
      repository: 'fixture',
      revision: 'r1',
      locate: (hash, lang) => ({ path: `tooltips/${hash}.json`, selector: ['text', lang, 'text'] }),
    },
    () => `g_exports${++id}000`,
  );
};
const snapshot = (
  documents: Tooltip[],
  mode: 'authored' | 'live' = 'live',
): GlobalImpactSnapshot => ({
  repository: 'fixture',
  revision: 'r1',
  mode,
  aliases: {},
  types: Object.fromEntries(documents.map((document) => [document.hash, 'Weapon Perk'])),
  tooltips: Object.fromEntries(documents.map((document) => [document.hash, document])),
});

it('projects ordered exports byte-for-byte, with comments, CRLF, metadata, and language absence', () => {
  const source = tooltip(
    1,
    '// Preserve\r\nexport anti_barrier (\r\n  First\r\nNext\r\n)\r\n\r\nexport overload (\r\nSecond\r\n)\r\n',
  );
  source.text.de = { ...source.text.en!, text: '' };
  const store = inventory([source]);
  expect(projectGlobals(store)).toEqual({ 1: source });
  expect(exportLegacy(Object.values(projectGlobals(store)), 0)).toEqual(exportLegacy([source], 0));
  expect(store.entries.map((entry) => entry.name)).toEqual(['anti_barrier', 'overload']);
  expect(store.entries[0].definitions.en?.provenance).toMatchObject({
    hash: 1,
    path: 'tooltips/1.json',
  });
  expect(store.entries.every((entry) => !entry.definitions.de)).toBe(true);
  for (const name of ['hidden Name', 'myexport', 'A[B'])
    expect(validGlobalName('exports', name)).toBe(false);
  expect(
    globalRecordSchema.safeParse({
      ...store.entries[0],
      definitions: { en: { ...store.entries[0].definitions.en, body: '' } },
    }).success,
  ).toBe(false);
  const hidden = tooltip(1, 'export hidden Name (\nBody\n)');
  expect(projectGlobals(inventory([hidden]))).toEqual({ 1: hidden });
});

it('rewrites only hash-1 import names, preserving comments, CRLF, local sources, and labels', () => {
  const source =
    '// import anti_barrier from global\r\n/*\r\nimport anti_barrier from 1\r\n*/\r\nimport anti_barrier from global\r\nimport anti_barrier from 1\r\nimport anti_barrier from 01\r\nimport anti_barrier from 40\r\nimport main from global\r\n<title anti_barrier [anti_barrier] />';
  const result = rewriteGlobalReferences(source, 'exports', 'anti_barrier', 'Barrier');
  expect(result.edits).toHaveLength(3);
  expect(result.text).toBe(
    source.replace(
      'import anti_barrier from global\r\nimport anti_barrier from 1\r\nimport anti_barrier from 01',
      'import Barrier from global\r\nimport Barrier from 1\r\nimport Barrier from 01',
    ),
  );
});

it('refuses newly introduced local/export name clashes, including fallback', () => {
  const before = inventory([tooltip(1, '')]);
  const after = inventory([tooltip(1, 'export Barrier (\nBody\n)')]);
  expect(() =>
    assertGlobalTransition(before, after, { 40: tooltip(40, 'export Barrier (\nLocal\n)') }),
  ).toThrow(/clash/);
});

it('uses real resolver imports for direct, nested, title, alias, and deleted export consumers', () => {
  const docs = [
    tooltip(1, 'export Barrier (\nOld\n)'),
    tooltip(2, ''),
    tooltip(3, 'title Info (\nimport Barrier from global\n)'),
    tooltip(40, 'import Barrier from 1'),
    tooltip(41, 'import Outer from 51'),
    tooltip(50, 'export Outer (\nimport Barrier from global\n)'),
    tooltip(60, 'Plain'),
  ];
  const before = snapshot(docs);
  before.aliases = { 51: { to: 50, kind: 'name' } };
  const after = structuredClone(before);
  after.revision = 'r2';
  after.tooltips[1].text.en!.text = 'export Barrier (\nNew\n)';
  Reflect.deleteProperty(after.tooltips, '40');
  const result = calculateGlobalImpact(
    before,
    after,
    [
      {
        cause: { globalId: 'g_exports1000', beforeRevision: 'r1', afterRevision: 'r2' },
        kind: 'exports',
        beforeName: 'Barrier',
        afterName: 'Barrier',
      },
    ],
    'live',
  );
  expect(result.complete).toBe(true);
  expect(result.rows.map((row) => row.consumer.hash)).toEqual([40, 41, 50, 60]);
  expect(result.rows.find((row) => row.consumer.hash === 40)?.after).toBeNull();
  expect(result.rows.find((row) => row.consumer.hash === 41)?.after?.rendered).toContain('New');
  expect(result.rows.every((row) => row.reason === 'aggregate-import')).toBe(true);
});

it('composes approved exports over published entries without leaking another saved body', async () => {
  const docs = [
    tooltip(1, 'export Barrier (\nOld barrier\n)\nexport Overload (\nOld overload\n)'),
    tooltip(2, ''),
    tooltip(3, ''),
    tooltip(40, 'import Barrier from global'),
  ];
  const published = inventory(docs.slice(0, 3));
  const saved = structuredClone(published);
  saved.entries[0].revision = 'r2';
  saved.entries[0].definitions.en!.body = 'New barrier';
  saved.entries[0].definitions.en!.revision = 'r2';
  saved.entries[1].revision = 'r3';
  saved.entries[1].definitions.en!.body = 'Unapproved overload';
  saved.entries[1].definitions.en!.revision = 'r3';
  const composed = composeGlobalRelease(published, saved, [saved.entries[0].id]);
  expect(projectGlobals(composed)[1].text.en!.text).toBe(
    'export Barrier (\nNew barrier\n)\nexport Overload (\nOld overload\n)',
  );
  const authored = snapshot(
    Object.values({ ...snapshot(docs).tooltips, ...projectGlobals(saved) }),
    'authored',
  );
  const plans = await planGlobalRelease({
    saved,
    published,
    authored,
    live: snapshot(docs),
    causes: [],
    destination: 'live',
  });
  expect(plans).toHaveLength(1);
  expect(plans[0].hashes).toEqual([1, 2, 3, 40]);
  expect(plans[0].rows[0].view.after?.rendered).toContain('New barrier');
  expect(plans[0].ids).toHaveLength(2);
});
