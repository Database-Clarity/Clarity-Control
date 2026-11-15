import { describe, expect, it } from 'vitest';
import { inventoryGlobals, projectGlobals } from './projection.js';
import { assertGlobalTransition } from './transition.js';
import { globalReferenceSpans, rewriteGlobalReferences } from './references.js';
import type { Tooltip } from '../schemas.js';
import { globalsCensus } from '../../../../scripts/globals/census.js';
import { database, fixture } from '../../test/helpers.js';
import { migrateLegacy } from '../migrateLegacy.js';

const cell = (text: string) => ({ text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' });
const tooltip = (hash: number, en: string, de?: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: cell(en), ...(de === undefined ? {} : { de: cell(de) }) },
});
const inventory = (docs: Tooltip[]) => {
  let id = 0;
  return inventoryGlobals(
    docs,
    { repository: 'editor-data', revision: 'source1' },
    () => `g_fixture${++id}0000`,
  );
};

it('round-trips order, comments, CRLF, empty values, language absence, and metadata exactly', () => {
  const variables = tooltip(2, '// note\r\nvar damage =   10 \t\r\n\r\nvar none = empty\r\n', '');
  variables.text.en!.sourceUpdatedAt = '2025-01-01T00:00:00Z';
  const titles = tooltip(3, '/* note */\r\ntitle Info (\r\n  Body\r\nNext\r\n)\r\n');
  const store = inventory([variables, titles]);
  expect(projectGlobals(store)).toEqual({ 2: variables, 3: titles });
  expect(store.entries.find((v) => v.name === 'none')!.definitions.en!.body).toBe('');
  expect(store.entries.find((v) => v.name === 'Info')!.definitions.en!.body).toBe('  Body\r\nNext');
  expect(store.entries.every((v) => v.definitions.de === undefined)).toBe(true);
});

it('retains stable IDs and ancestry across rename and history, and rejects identity edits', () => {
  const before = inventory([tooltip(2, 'var damage = 10')]);
  const after = structuredClone(before),
    entry = after.entries[0];
  entry.name = 'hit';
  entry.revision = 'r2';
  entry.nameHistory.push({
    name: 'damage',
    revision: 'source1',
    at: '2026-01-02T00:00:00Z',
    by: 'alice',
  });
  expect(() => assertGlobalTransition(before, after, {})).not.toThrow();
  expect(projectGlobals(after)[2].text.en!.text).toBe('var hit = 10');
  expect(entry.id).toBe(before.entries[0].id);
  expect(entry.definitions.en!.provenance).toEqual(before.entries[0].definitions.en!.provenance);
  entry.id = 'g_replaced000';
  expect(() => assertGlobalTransition(before, after, {})).toThrow();
});

it('rejects duplicate declarations, missing provenance/recipes, mixed prose, and commented definitions', () => {
  for (const source of ['var a = 1\nvar a = 2', 'prose\nvar a = 1', '/*\nvar a = 1\n*/'])
    expect(() => inventory([tooltip(2, source)])).toThrow();
  const store = inventory([tooltip(2, 'var a = 1')]);
  Reflect.deleteProperty(store.entries[0].definitions.en!, 'provenance');
  expect(() => projectGlobals(store)).toThrow();
  const missing = inventory([tooltip(2, 'var a = 1')]);
  missing.aggregates[0].languages.en!.segments = [];
  expect(() => projectGlobals(missing)).toThrow();
});

it('refuses new local clashes in any category/language and protects the legacy arrow', () => {
  const before = inventory([tooltip(2, '')]);
  const after = inventory([tooltip(2, 'var a = 1')]);
  expect(() => assertGlobalTransition(before, after, { 40: tooltip(40, 'var a = 2\n#a') })).toThrow(
    /clash/,
  );
  const arrow = inventory([tooltip(2, 'var e = 🡅')]),
    removed = structuredClone(arrow);
  removed.entries[0].tombstone = { at: '2026-01-02T00:00:00Z', by: 'alice' };
  removed.entries[0].revision = 'r2';
  removed.aggregates[0].languages.en!.segments = [];
  expect(() => assertGlobalTransition(arrow, removed, {})).toThrow(/protected/);
});

it('rewrites only exact legacy/braced references and title target spans, never comments or labels', () => {
  const source = '// #a #{a}\r\n/* #a */\r\n#a #{a} #ab #{ab}\r\n<title #a label [Info] />';
  const rewritten = rewriteGlobalReferences(source, 'variables', 'a', 'damage');
  expect(rewritten.text).toBe(
    '// #a #{a}\r\n/* #a */\r\n#damage #{damage} #ab #{ab}\r\n<title #a label [Info] />',
  );
  expect(rewritten.edits).toHaveLength(2);
  expect(
    globalReferenceSpans(source, 'variables').map((ref) => source.slice(ref.from, ref.to)),
  ).toEqual(['#a', '#{a}', '#ab', '#{ab}']);
  expect(
    rewriteGlobalReferences(
      '// <title Info [Info] />\n<title Info [Info] />',
      'titles',
      'Info',
      'Other',
    ).text,
  ).toBe('// <title Info [Info] />\n<title Info [Other] />');
});

describe.each(['live', 'intermediate'])('%s complete immutable fixture census', (name) => {
  it('proves aggregate, legacy consumer-input, and real resolver output parity', () => {
    const raw = database(name);
    const source = (
      fixture('provenance') as { sources: Record<string, { repository: string; commit: string }> }
    ).sources[name];
    const tooltips = Object.fromEntries(migrateLegacy(raw).map((v) => [v.hash, v]));
    const census = globalsCensus({
      repository: source.repository,
      revision: source.commit,
      tooltips,
      aliases: {},
      types: Object.fromEntries(Object.values(raw.perks).map((v) => [v.hash, v.type])),
      mode: 'live',
    });
    console.log('GLOBALS CENSUS', JSON.stringify({ ...census, store: undefined }));
    expect(census.definitions).toBe(13);
    expect(census.aggregateParity).toBe(true);
    expect(census.consumerInputParity).toBe(true);
    expect(census.renderedParity).toBe(true);
    expect(census.resolverComplete).toBe(true);
    expect(census.blockers).toEqual([]);
    expect(census.resolvedConsumerCells).toBe(name === 'live' ? 1774 : 1776);
    const classifications = census.entries.find((v) => v.name === 'CombatantClassifications')!;
    expect(classifications.resolverConsumers).toBeGreaterThan(classifications.authoredTooltips);
    expect(census.entries.find((v) => v.name === 'e')!.authoredTooltips).toBeGreaterThan(200);
  }, 120_000);
});
