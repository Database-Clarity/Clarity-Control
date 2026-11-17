import { expect, test } from 'vitest';
import { compile } from 'sass';
import { fileURLToPath } from 'node:url';
import { isV1Lines, lastEdit, outputRows, renderLine, rowKeys } from './output';

test('Exotic output uses the themed yellow colour for lines, text, and arrows', () => {
  const line = renderLine({
    style: ['exotic'],
    parts: [
      { text: 'Name', style: ['exotic'] },
      { icon: 'arrow', style: ['exotic'] },
    ],
  });
  const css = compile(
    fileURLToPath(new URL('../preview/TooltipPreview.module.scss', import.meta.url)),
  ).css;
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
    match[1].split(',').some((selector) => selector.trim() === '.exotic'),
  );
  expect(line.classNames).toEqual(['exotic']);
  expect(line.linesContent?.map((part) => part.classNames)).toEqual([
    ['exotic'],
    ['arrow', 'exotic'],
  ]);
  expect(rule?.[2]).toMatch(/color:\s*var\(--tp-yellow\)/);
});

test('format v1 lines map to the class names the tooltip renderer draws', () => {
  expect(
    renderLine({
      style: ['bold'],
      parts: [
        { icon: 'arc' },
        { text: 'Jolt', element: 'arc' },
        { text: '30%', style: ['pve'] },
        { text: 'Docs', link: 'https://d2clarity.com' },
        { text: 'Term', note: [{ parts: [{ text: 'Hover' }] }] },
      ],
    }),
  ).toEqual({
    classNames: ['bold'],
    linesContent: [
      { classNames: ['arc'] },
      { text: 'Jolt', classNames: ['elementText', 'arc'] },
      { text: '30%', classNames: ['pve'] },
      { text: 'Docs', link: 'https://d2clarity.com', classNames: ['link'] },
      { text: 'Term', title: [{ linesContent: [{ text: 'Hover' }] }], classNames: ['title'] },
    ],
  });
  expect(renderLine({ spacer: true })).toEqual({ classNames: ['spacer'] });
  expect(isV1Lines([{ parts: [] }, { spacer: true }])).toBe(true);
  // An older engine's lines (class names and spans) are not format v1.
  expect(isV1Lines([{ linesContent: [{ text: 'a' }] }])).toBe(false);
});

test('output rows hold one tooltip line each, and the last edit names what changed', () => {
  const before = {
    hash: 1,
    descriptions: { en: [{ parts: [{ text: 'A' }] }, { parts: [{ text: 'B' }] }] },
  };
  const rows = outputRows(before);
  expect(rows.filter((row) => row.line).map((row) => row.line)).toEqual([
    { language: 'en', index: 0 },
    { language: 'en', index: 1 },
  ]);
  const keys = new Set(rowKeys(rows));
  const changed = outputRows({
    hash: 1,
    descriptions: { en: [{ parts: [{ text: 'A' }] }, { parts: [{ text: 'C' }] }] },
  });
  const edit = lastEdit(changed, keys);
  expect(edit.message).toBe('1 line changed by your last edit');
  expect([...edit.changed].map((row) => row.line)).toEqual([{ language: 'en', index: 1 }]);
  expect(lastEdit(rows, keys).message).toBe('Your last edit does not change this perk');
  const shorter = outputRows({ hash: 1, descriptions: { en: [{ parts: [{ text: 'A' }] }] } });
  expect(lastEdit(shorter, keys).message).toBe('1 line removed by your last edit');
  // A text-shape string breaks into one row per tooltip line.
  expect(outputRows({ descriptions: { en: 'One\nTwo' } }).filter((row) => row.line)).toHaveLength(
    2,
  );
});

test('equal lines stay apart: within a language (repeats) and across languages', () => {
  const plain = { parts: [{ text: 'Plain' }] };
  const bold = { parts: [{ text: 'Plain', style: ['bold'] }] };
  // Dropping bold turns the second line into a copy of the first: still one changed line.
  const before = new Set(rowKeys(outputRows({ descriptions: { en: [plain, bold] } })));
  const edit = lastEdit(outputRows({ descriptions: { en: [plain, plain] } }), before);
  expect(edit.message).toBe('1 line changed by your last edit');
  expect([...edit.changed].map((row) => row.line)).toEqual([{ language: 'en', index: 1 }]);
  // The same change in a second language whose line already read that way is still marked.
  const both = new Set(rowKeys(outputRows({ descriptions: { en: [bold], de: [plain] } })));
  const after = lastEdit(outputRows({ descriptions: { en: [plain], de: [plain] } }), both);
  expect([...after.changed].map((row) => row.line)).toEqual([{ language: 'en', index: 0 }]);
  // Two equal lines removed count as two.
  const two = new Set(rowKeys(outputRows({ descriptions: { en: [plain, plain, bold] } })));
  expect(lastEdit(outputRows({ descriptions: { en: [bold] } }), two).message).toBe(
    '2 lines removed by your last edit',
  );
});
