import { describe, expect, it } from 'vitest';
import { buildGlobalUsageIndex, markupImports, parseMarkup, type Tooltip } from '@clarity/core';
import {
  createGlobalUsageProjection,
  globalDefinitions,
  globalPath,
  globalUsageCount,
  globalUsageEntries,
} from './model';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedBy: 'test', updatedAt: '2026-11-11T00:00:00Z' } },
  associated: [],
});
const sources = {
  1: tooltip(1, 'export Shared (\n#Rate\n)\nexport hidden Secret (\nBody\n)'),
  2: tooltip(
    2,
    '// var Hidden = no\n/*\nvar AlsoHidden = no\n*/\nvar Rate = 10\nvar Empty = empty',
  ),
  3: tooltip(3, 'title Heading (\n#Rate\n)'),
  10: tooltip(
    10,
    'var Rate = local\n#Rate\n<title Label [Heading] />\nimport Shared from global\n// #Rate\n/* #Rate */',
  ),
};

describe('read-only aggregate globals', () => {
  it('extracts bare names and original source lines for every type, ignoring comments', () => {
    const entries = globalDefinitions(sources);
    expect(entries.map(({ name }) => name).sort()).toEqual([
      'Empty',
      'Heading',
      'Rate',
      'Secret',
      'Shared',
    ]);
    expect(entries.find(({ name }) => name === 'Rate')).toMatchObject({
      hash: 2,
      lines: { en: 5 },
      definitions: { en: '10' },
    });
    expect(entries.find(({ name }) => name === 'Heading')?.definitions.en).toBe('#Rate');
    expect(entries.find(({ name }) => name === 'Empty')?.definitions.en).toBe('');
  });
  it('preserves the usage index counts, including global precedence over local names', () => {
    const entries = globalUsageEntries(sources);
    for (const expected of buildGlobalUsageIndex(sources)) {
      expect(
        entries.find(({ kind, name }) => kind === expected.kind && name === expected.name)?.usages,
      ).toEqual(expected.usages);
    }
    expect(entries.find(({ name }) => name === 'Shared')?.usages).toEqual([
      { hash: 10, lang: 'en', line: 4, source: 'import Shared from global' },
    ]);
    expect(globalUsageCount(entries.filter(({ name }) => name === 'Rate'))).toBe(3);
  });
  it('keeps aggregate routes distinct and drops stale reference highlights', () => {
    const entry = globalDefinitions(sources).find(({ name }) => name === 'Heading')!;
    expect(globalPath(entry, '?lang=de&line=900&variant=10')).toBe('/t/3?lang=de&global=Heading');
  });
  it('uses production import boundaries for authored export references', () => {
    const lines = [
      '  import Shared from global',
      '\timport Shared from global',
      '// import Shared from global',
      '/*',
      'import Shared from global',
      '*/',
      'import Shared from global // not recognised before comment removal',
      'import Shared from global   ',
      'import  Shared  from 1  ',
      'import Shared from 10',
    ];
    const result = globalUsageEntries({ ...sources, 10: tooltip(10, lines.join('\n')) });
    expect(result.find(({ name }) => name === 'Shared')?.usages).toEqual([
      { hash: 10, lang: 'en', line: 8, source: lines[7] },
      { hash: 10, lang: 'en', line: 9, source: lines[8] },
    ]);
    const globals = { variables: '', titles: '', imports: { 1: 'export Shared (\nExpanded\n)' } };
    for (const line of [lines[0], lines[1], lines[6]]) {
      expect(markupImports(line)).toEqual([]);
      expect(JSON.stringify(parseMarkup(line, globals).lines)).not.toContain('Expanded');
    }
    for (const line of [lines[7], lines[8]]) {
      expect(markupImports(line)).toEqual([line]);
      expect(JSON.stringify(parseMarkup(line, globals).lines)).toContain('Expanded');
    }
  });
  it('updates definitions and cached source usages after a draft changes', () => {
    globalUsageEntries(sources);
    const next = globalUsageEntries({
      ...sources,
      2: tooltip(2, 'var Rate = 20'),
      10: tooltip(10, 'No references'),
    });
    expect(next.find(({ name }) => name === 'Rate')).toMatchObject({ definitions: { en: '20' } });
    expect(next.find(({ name }) => name === 'Rate')?.usages.map(({ hash }) => hash)).toEqual([
      1, 3,
    ]);
  });
});

it('incremental draft usage projections equal a fresh authored-reference index', () => {
  const project = createGlobalUsageProjection(sources);
  const rounds: Record<string, { next: Tooltip }>[] = [
    {},
    { 2: { next: tooltip(2, 'var Rate = 50\nvar Empty = empty') } },
    { 10: { next: tooltip(10, '#Rate\nimport Shared from 1') } },
    { 2: { next: tooltip(2, 'var New = 10') }, 10: { next: tooltip(10, '#New') } },
    { 1: { next: tooltip(1, 'export hidden Shared (\n#Rate\n)') } },
    {},
  ];
  for (const drafts of rounds) {
    expect(project(drafts)).toEqual(
      globalUsageEntries({
        ...sources,
        ...Object.fromEntries(Object.entries(drafts).map(([hash, { next }]) => [hash, next])),
      }),
    );
    expect(project(drafts)).toBe(project(drafts));
  }
});

it('retains usage-list identity when only an aggregate value changes', () => {
  const project = createGlobalUsageProjection(sources);
  const first = project({});
  const second = project({ 2: { next: tooltip(2, 'var Rate = 99\nvar Empty = empty') } });
  expect(second.find(({ name }) => name === 'Rate')?.usages).toBe(
    first.find(({ name }) => name === 'Rate')?.usages,
  );
});
