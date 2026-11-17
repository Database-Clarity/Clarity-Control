import { expect, test } from 'vitest';
import { isV1Lines, lastEdit, outputRows, renderLine, rowKey } from './output';

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
  const keys = new Set(rows.map(rowKey));
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
