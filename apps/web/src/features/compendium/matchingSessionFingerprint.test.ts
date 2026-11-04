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
