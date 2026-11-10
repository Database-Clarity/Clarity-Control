import { describe, expect, it } from 'vitest';
import type { QueueRow } from './queue';
import { placeLabel, queuePlace } from './queuePlace';

const row = (hash: number): QueueRow => ({
  key: `${hash}:de`,
  hash,
  language: 'de',
  name: `Tooltip ${hash}`,
  categoryId: 'perks',
  category: 'Perks',
  state: 'missing',
  haystack: '',
});
const rows = [1, 2, 3, 4].map(row);
const hashes = (place: ReturnType<typeof queuePlace>) => [place.previous?.hash, place.next?.hash];

describe('queue place', () => {
  it('gives the position and both neighbours, with none past either end', () => {
    expect(queuePlace(rows, 2)).toMatchObject({ index: 2, total: 4, left: false });
    expect(hashes(queuePlace(rows, 2))).toEqual([1, 3]);
    expect(hashes(queuePlace(rows, 1))).toEqual([undefined, 2]);
    expect(hashes(queuePlace(rows, 4))).toEqual([3, undefined]);
    expect(placeLabel(queuePlace(rows, 2))).toBe('2 of 4');
  });

  it('keeps the neighbours of a tooltip that left the queue while open', () => {
    const anchor = { hash: 2, rows, index: 1 };
    const after = rows.filter((entry) => entry.hash !== 2);
    const place = queuePlace(after, 2, anchor);
    expect(place).toMatchObject({ index: 0, total: 3, left: true });
    // Next is what followed it: nothing skipped, nothing repeated.
    expect(hashes(place)).toEqual([1, 3]);
    expect(placeLabel(place)).toBe('Done · 3 left');
    // A neighbour that left too is passed over, in both directions.
    expect(hashes(queuePlace([row(4)], 2, anchor))).toEqual([undefined, 4]);
    expect(hashes(queuePlace([row(1)], 2, anchor))).toEqual([1, undefined]);
  });

  it('starts at the first row for a tooltip the queue never listed while open', () => {
    const place = queuePlace(rows, 9, { hash: 2, rows, index: 1 });
    expect(place).toMatchObject({ index: 0, left: false });
    expect(hashes(place)).toEqual([undefined, 1]);
    expect(placeLabel(place)).toBe('Not in queue · 4 left');
  });

  it('says the queue is done when nothing is left', () => {
    const place = queuePlace([], 2, { hash: 2, rows, index: 1 });
    expect(hashes(place)).toEqual([undefined, undefined]);
    expect(placeLabel(place)).toBe('Queue done');
  });
});
