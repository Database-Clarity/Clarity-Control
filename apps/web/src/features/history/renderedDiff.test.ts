import { expect, it } from 'vitest';
import { parseMarkup, type MarkupLine } from '@clarity/core';
import { changedSourceLines, renderedDiff, type DiffSpan } from './renderedDiff';

const globals = { variables: '', titles: '' };
const parts = (lines: MarkupLine[]): DiffSpan[] =>
  lines.flatMap((line) => [
    ...(line.linesContent ?? []),
    ...(line.table?.flatMap((row) => row.rowContent?.flatMap((cell) => cell.cellContent) ?? []) ??
      []),
  ]);
it('marks changed words on both sides, preserves unchanged words, and never parses broken source fragments', () => {
  const result = renderedDiff('<pve Deals 20 damage />', '<pve Deals 30 damage />', globals);
  expect(
    parts(result.before)
      .filter((part) => part.diffKind)
      .map((part) => part.text)
      .join(''),
  ).toBe('20');
  expect(
    parts(result.after)
      .filter((part) => part.diffKind)
      .map((part) => part.text)
      .join(''),
  ).toBe('30');
  expect(
    parts(result.after)
      .map((part) => part.text)
      .join(''),
  ).toBe('Deals 30 damage');
});
it.each([
  ['<pve Same />', '<pvp Same />'],
  ['<background Same />', 'Same'],
  ['<primary/>', '<special/>'],
  ['<link Same [https://example.com/a] />', '<link Same [https://example.com/b] />'],
])('keeps semantic changes visible: %s → %s', (before, after) => {
  const result = renderedDiff(before, after, globals);
  expect(parts(result.before).some((part) => part.diffKind === 'delete')).toBe(true);
  expect(parts(result.after).some((part) => part.diffKind === 'insert')).toBe(true);
  expect(changedSourceLines(before, after)).toContain('line 1');
});
it('locates a source-only change even when the real renderer outputs identical lines', () => {
  const before = 'Same\nvar unused = 1',
    after = 'Same\nvar unused = 2';
  expect(parseMarkup(before, globals).lines).toEqual(parseMarkup(after, globals).lines);
  expect(changedSourceLines(before, after)).toBe(
    'Source changed: previous line 2; current line 2. Raw shows markup edits.',
  );
});
it('renders real imports, nested titles, and legacy tables without dropping their differences', () => {
  const result = renderedDiff(
    'import main from 42\n< table wide >\n| Old\n<$>',
    'import main from 43\n< table wide >\n| New\n<$>',
    {
      ...globals,
      imports: { 42: '<pve Previous />', 43: '<pvp Current />' },
    },
  );
  expect(
    parts(result.before)
      .filter((part) => part.diffKind)
      .map((part) => part.text)
      .join(''),
  ).toContain('Previous');
  expect(
    parts(result.after)
      .filter((part) => part.diffKind)
      .map((part) => part.text)
      .join(''),
  ).toContain('New');
});
