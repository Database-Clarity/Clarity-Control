import { describe, expect, it } from 'vitest';
import { buildGlobalUsageIndex, type Tooltip } from '@clarity/core';
import { globalDefinitions, globalPath, globalUsageCount, globalUsageEntries } from './model';

const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedBy: 'test', updatedAt: '2026-11-11T00:00:00Z' } },
  associated: [],
});
const sources = {
  1: tooltip(1, 'export Shared (\n#Rate\n)'),
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
    expect(entries.map(({ name }) => name).sort()).toEqual(['Empty', 'Heading', 'Rate', 'Shared']);
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
