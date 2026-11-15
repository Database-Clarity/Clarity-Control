import { expect, it } from 'vitest';
import { parseMarkup } from './parse.js';
import type { MarkupLine, MarkupSpan } from './types.js';

function parts(lines: MarkupLine[]): MarkupSpan[] {
  return lines.flatMap((line) => [
    ...(line.linesContent ?? []),
    ...(line.table?.flatMap((row) => row.rowContent?.flatMap((cell) => cell.cellContent) ?? []) ??
      []),
  ]);
}
const indexedValues = (spans: MarkupSpan[]) =>
  spans.flatMap(
    (span) => span.slots?.map((slot) => [slot.id, span.text?.slice(slot.from, slot.to)]) ?? [],
  );

it('carries exact source identities through prose, maths, and table preparation', () => {
  const source = 'Gain 5 stacks for ${2*3} seconds.\n< table wide >\n| 12 damage\n<$>';
  const indexed = parts(parseMarkup(source, undefined, { slots: [7, 9, 11] }).lines);
  expect(indexedValues(indexed)).toEqual([
    [7, '5'],
    [9, '6'],
    [11, '12'],
  ]);
});

it('never attributes variable-derived digits to a source number', () => {
  const source = 'var d = 5\nDeals #d damage and 7 healing.';
  const indexed = parts(parseMarkup(source, undefined, { slots: [1, 2] }).lines);
  expect(indexedValues(indexed)).toEqual([[2, '7']]);
  expect(indexed.map((span) => span.text ?? '').join('')).toContain('Deals 5 damage');
  expect(indexed.flatMap((span) => span.variables ?? []).map((variable) => variable.name)).toEqual([
    'd',
  ]);
});

it('adds source variable provenance only with the option, never from equal numeric values', () => {
  const source = 'var d = 5\nVariable #d and literal 5.\n<link Link [https://example.com/#d] />';
  const ordinary = parseMarkup(source);
  expect(JSON.stringify(ordinary)).not.toContain('"variables"');
  const indexed = parts(parseMarkup(source, undefined, { slots: [1, 2] }).lines);
  expect(
    indexed.flatMap((span) =>
      (span.variables ?? []).map((variable) => [
        variable.name,
        span.text?.slice(variable.from, variable.to),
      ]),
    ),
  ).toEqual([['d', '5']]);
  expect(indexedValues(indexed)).toEqual([[2, '5']]);
  expect(parseMarkup(source)).toEqual(ordinary);
});

it('keeps styled span boundaries, title bodies, and undecorated parse output unchanged', () => {
  const source =
    '<solar Damage 5 /> for 10 seconds.\ntitle Info (\nDetail 12.\n)\n<title Details [Info] />';
  const original = parseMarkup(source);
  const indexed = parseMarkup(source, undefined, { slots: [1, 2, 3] });
  const stripped = JSON.parse(JSON.stringify(indexed), (key, value) =>
    key === 'slots' ? undefined : value,
  );
  expect(stripped).toEqual(original);
  expect(parseMarkup(source)).toEqual(original);
  expect(indexedValues(parts(indexed.lines))).toEqual([
    [1, '5'],
    [2, '10'],
  ]);
});
