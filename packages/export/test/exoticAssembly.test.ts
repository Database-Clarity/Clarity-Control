import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  markupInlineRanges,
  parseMarkup,
  validateText,
  type MarkupGlobals,
  type MarkupLine,
} from '@clarity/core';
import {
  buildLegacy,
  compile,
  deployedLegacyPresets,
  newStyleFile,
  styles,
  type LegacyInput,
} from '../src/index.js';

interface MatrixRow {
  id: string;
  text: string;
  globals: MarkupGlobals;
  lines: MarkupLine[];
  expected: Record<string, string>;
}
const { rows } = JSON.parse(
  readFileSync(new URL('./fixtures/exotic-assembly-base.json', import.meta.url), 'utf8'),
) as { rows: MatrixRow[] };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inputFor = (row: MatrixRow): LegacyInput => {
  const perk = (hash: number, main: string): LegacyInput['perks'][string] => ({
    hash,
    name: 'Probe',
    type: 'Weapon Trait',
    uploadedBy: 'test',
    lastUpload: 1,
    updateTracker: { descriptions: {} },
    inLiveDatabase: true,
    uploadToLive: true,
    editor: { en: { main, secondary: '' } },
  });
  return {
    perks: {
      1: perk(1, ''),
      2: perk(2, row.globals.variables),
      3: perk(3, row.globals.titles),
      100: perk(100, row.text),
      ...Object.fromEntries(
        Object.entries(row.globals.imports ?? {}).map(([id, source]) => [
          id,
          perk(Number(id), source),
        ]),
      ),
    },
  };
};

test.each(rows)(
  'literal-only matrix: $id preserves the base resolver and all eleven outputs',
  (row) => {
    const parsed = parseMarkup(row.text, row.globals);
    expect(JSON.parse(JSON.stringify(parsed.lines))).toEqual(row.lines);
    expect(JSON.stringify(parsed.lines)).not.toContain('"exotic"');
    expect(
      parsed.diagnostics.some(
        (issue) => issue.severity === 'warning' && issue.message.includes('<exotic'),
      ),
    ).toBe(true);
    expect(parsed.diagnostics.some((issue) => issue.severity === 'error')).toBe(false);
    const input = inputFor(row);
    const catalog = {
      items: Object.fromEntries(Object.keys(input.perks).map((id) => [id, { categoryId: 'all' }])),
      categories: [{ id: 'all' }],
    };
    for (const preset of deployedLegacyPresets)
      expect(sha(buildLegacy(input, preset)), preset).toBe(row.expected[preset]);
    for (const style of styles) {
      const config = newStyleFile('matrix', style);
      config.data.categories = ['all'];
      expect(sha(compile(input, config, { catalog }).bytes), style).toBe(
        row.expected[`v1:${style}`],
      );
    }
  },
);

test('every unknown resolved tag gets a non-blocking warning; assembled yellow remains supported', () => {
  for (const color of ['orange', 'exotic']) {
    const issues = validateText(`var color = ${color}\n<#color Text />`, 'en');
    expect(
      issues.some((issue) => issue.severity === 'warning' && issue.message.includes(`<${color}`)),
    ).toBe(true);
    expect(issues.some((issue) => issue.severity === 'error')).toBe(false);
  }
  const yellow = parseMarkup('var color = yellow\n<#color Text />');
  expect(JSON.stringify(yellow.lines)).toContain('yellow');
  expect(yellow.diagnostics).toEqual([]);
  expect(
    parseMarkup('var open = <\n#open exotic Gjallarhorn />').lines[0].linesContent?.[0].text,
  ).toBe('< exotic Gjallarhorn />');
});

test('the source-facing Exotic arrow wrapper remains one complete insertion range', () => {
  const source = '<exotic a <arrow/> b />';
  expect(
    markupInlineRanges(source).every(({ from, to }) => source.slice(from, to) === source),
  ).toBe(true);
  expect(parseMarkup(source)).toEqual(parseMarkup(source.replace('<exotic', '<yellow')));
});
