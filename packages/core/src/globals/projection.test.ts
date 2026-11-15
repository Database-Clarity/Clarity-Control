import { describe, expect, it } from 'vitest';
import { inventoryGlobals, projectGlobals } from './projection.js';
import { assertGlobalTransition } from './transition.js';
import { globalReferenceSpans, rewriteGlobalReferences } from './references.js';
import type { Tooltip } from '../schemas.js';
import { legacyGlobalsCensus } from '../../../../scripts/globals/census.js';
import { database, fixture } from '../../test/helpers.js';

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
    {
      repository: 'editor-data',
      revision: 'source1',
      locate: (hash, lang) => ({ path: `tooltips/${hash}.json`, selector: ['text', lang, 'text'] }),
    },
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

it('rejects incompatible title targets, and preserves exact target boundaries and link literals', () => {
  for (const name of ['A[B', 'A]B']) {
    expect(() => inventory([tooltip(3, `title ${name} (\nBody\n)`)])).toThrow();
    expect(() =>
      rewriteGlobalReferences(`<title Label [${name}] />`, 'titles', name, 'Other'),
    ).toThrow();
  }
  const source = '<title Info (details) [Info] />';
  const rewritten = rewriteGlobalReferences(source, 'titles', 'Info', 'Other');
  expect(rewritten.text).toBe('<title Info (details) [Other] />');
  expect(rewritten.edits.map((span) => source.slice(span.from, span.to))).toEqual(['Info']);
  expect(
    rewriteGlobalReferences('<title Label [part] [Info] />', 'titles', 'Info', 'Other').edits,
  ).toEqual([]);
  expect(
    rewriteGlobalReferences(
      '<link #damage [https://example.test/#damage] />\n<link #damage [#damage] />\n<link Label [#{damage}] />\nhttps://example.test/#damage #damage',
      'variables',
      'damage',
      'hit',
    ).text,
  ).toBe(
    '<link #damage [https://example.test/#damage] />\n<link #damage [#hit] />\n<link Label [#{hit}] />\nhttps://example.test/#damage #hit',
  );
});

it('refuses variable/title additions through aggregate fallback, including effective consumer text', () => {
  for (const [hash, global, local] of [
    [2, 'var damage = 10', 'var damage = 20\n#damage'],
    [3, 'title Info (\nGlobal\n)', 'title Info (\nLocal\n)\n<title Label [Info] />'],
  ] as const) {
    const before = tooltip(hash, '', ''),
      after = tooltip(hash, global, '');
    for (const doc of [before, after]) {
      doc.text.en!.updatedAt = '2026-10-01T00:00:00Z';
      doc.text.de!.sourceUpdatedAt = '2026-01-01T00:00:00Z';
    }
    expect(() =>
      assertGlobalTransition(inventory([before]), inventory([after]), {
        40: tooltip(40, 'Plain', local),
      }),
    ).toThrow(/clash/);
  }
});

it('protects arrow definitions against language removal, clearing, and replacement', () => {
  const before = inventory([tooltip(2, 'var e = 🡅')]);
  const removed = structuredClone(before);
  removed.entries[0].revision = 'r2';
  removed.entries[0].definitions = {};
  removed.aggregates[0].languages.en!.segments = [];
  expect(() => assertGlobalTransition(before, removed, {})).toThrow(/protected/);
  for (const body of ['', 'Other']) {
    const after = structuredClone(before);
    after.entries[0].revision = 'r2';
    after.entries[0].definitions.en!.revision = 'r2';
    after.entries[0].definitions.en!.body = body;
    expect(() => assertGlobalTransition(before, after, {})).toThrow(/protected/);
  }
});

describe.each(['live', 'intermediate'])('%s complete immutable fixture census', (name) => {
  it('proves aggregate, legacy consumer-input, and real resolver output parity', () => {
    const raw = database(name);
    const source = (
      fixture('provenance') as {
        sources: Record<string, { repository: string; commit: string; path: string }>;
      }
    ).sources[name];
    const census = legacyGlobalsCensus(raw, {
      repository: source.repository,
      revision: source.commit,
      path: source.path,
    });
    for (const entry of census.store.entries) {
      for (const [lang, definition] of Object.entries(entry.definitions)) {
        const origin = definition.provenance;
        expect(origin.path).toBe(source.path);
        expect(origin.selector).toEqual(['perks', String(origin.hash), 'editor', lang, 'main']);
        expect(origin.spanConvention).toBe('decoded-utf16');
        const decoded = raw.perks[origin.hash].editor[origin.lang]!.main;
        expect(decoded.slice(origin.from, origin.to)).toContain(entry.name);
      }
    }
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
