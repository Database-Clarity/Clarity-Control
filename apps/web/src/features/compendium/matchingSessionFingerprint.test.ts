import { expect, it } from 'vitest';
import { matchingSessionFingerprint } from './matchingSessionFingerprint';
import { sourceFingerprint } from './reviewProgress';

it('preserves canonical review evidence, including repeated cells and display-only styles', () => {
  const runs = [
    { text: 'A', bold: true, textAlign: 'left' as const },
    { text: 'B', bold: true },
  ];
  const value = [
    {
      gid: 'g',
      name: 'Tab',
      rows: [
        {
          name: 'Row',
          nameNorm: 'row',
          rowIndex: 1,
          cell: { plain: 'stale', runs, background: '#fff' },
        },
      ],
      grid: [{ row: 1, col: 1, cell: { plain: 'AB', runs, background: '#000' } }],
    },
  ];
  expect(matchingSessionFingerprint(value)).toBe(sourceFingerprint(value));
  runs[0].bold = false;
  expect(matchingSessionFingerprint(value)).toBe(sourceFingerprint(value));
});

it('treats prototype-like keys as evidence data', () => {
  const value = JSON.parse(
    '{"__proto__":{"safe":true},"constructor":"data","nested":{"b":2,"a":1}}',
  );
  const before = JSON.stringify(value);
  expect(matchingSessionFingerprint(value)).toBe(sourceFingerprint(value));
  expect(JSON.stringify(value)).toBe(before);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
});

it('preserves JSON property enumeration, escaping, and omitted optional values', () => {
  const value = {
    '10': 'ten',
    '2': 'two',
    '4294967295': 'not an index',
    '01': 'not an index either',
    optional: undefined,
    array: [undefined, null, true, '\n"\\\u0000', { z: 1, a: 2 }],
  };
  expect(matchingSessionFingerprint(value)).toBe(sourceFingerprint(value));
});

it('preserves strict adjacent-run evidence across shared styles and property orders', () => {
  const styles = [
    {},
    { bold: true },
    { bold: false },
    { bold: undefined },
    { italic: true, link: 'https://example.test' },
    { color: '#123456', fontSize: 11, underline: true },
  ];
  const cells = styles.flatMap((left) =>
    styles.map((right) => ({
      plain: 'Ignored display text',
      background: '#ffffff',
      runs: [
        { ...left, text: 'A', textAlign: 'left' },
        { ...right, text: '' },
        { text: 'B', ...Object.fromEntries(Object.entries(right).reverse()), textAlign: 'right' },
        { text: 'C', ...right },
        { ...left, text: '\n' },
      ],
    })),
  );
  expect(matchingSessionFingerprint(cells)).toBe(sourceFingerprint(cells));
});
