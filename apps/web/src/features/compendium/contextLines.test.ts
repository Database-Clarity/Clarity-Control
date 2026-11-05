import { expect, it } from 'vitest';
import type { CompendiumCell } from '@clarity/core';
import { contextLines } from './contextLines';

it('preserves text, empty physical lines, alignment, styles, and source data', () => {
  const cell: CompendiumCell = {
    plain: 'Heading\n\nDescription',
    runs: [
      { text: 'Heading\n\n', bold: true, textAlign: 'center' },
      { text: 'Description', italic: true },
    ],
  };
  const before = structuredClone(cell);
  const lines = contextLines(cell);
  expect(lines.map((line) => line.cell.plain).join('\n')).toBe(cell.plain);
  expect(lines[0].align).toBe('center');
  expect(lines[0].cell.runs[0].bold).toBe(true);
  expect(lines.at(-1)?.cell.runs.at(-1)?.italic).toBe(true);
  expect(cell).toEqual(before);
  expect(contextLines(cell)).toBe(lines);
});

it('keeps an unaligned multiline hyperlink in one native focus target', () => {
  const cell: CompendiumCell = {
    plain: 'A linked\nphrase\nTail',
    runs: [{ text: 'A linked\nphrase', href: 'https://example.invalid/' }, { text: '\nTail' }],
  };
  const lines = contextLines(cell);
  expect(lines.map((line) => line.cell.plain).join('\n')).toBe(cell.plain);
  expect(lines.flatMap((line) => line.cell.runs).filter((run) => run.href)).toEqual([cell.runs[0]]);
  expect(lines[0].block).toBe(false);
});
