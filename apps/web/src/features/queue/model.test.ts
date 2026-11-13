import { describe, expect, it } from 'vitest';
import {
  firstToDo,
  placeLabel,
  queuePlace,
  visitOf,
  visitState,
  type QueueItem,
  type WorkQueue,
} from './model';

const items: QueueItem[] = ['a', 'b', 'c', 'd'].map((key, at) => ({
  key,
  hash: at + 1,
  name: key,
}));
const queue = (change: Partial<WorkQueue> = {}): WorkQueue => ({
  version: 1,
  id: 'q1',
  source: 'drift',
  scope: 'shown',
  origin: { path: '/drift', restore: {} },
  items,
  skipped: [],
  current: 'a',
  finished: false,
  createdAt: 0,
  destination: null,
  ...change,
});
const doneOf =
  (...keys: string[]) =>
  (item: QueueItem) =>
    keys.includes(item.key);

describe('queuePlace', () => {
  it('counts the items still to do and steps over done ones', () => {
    const place = queuePlace(queue(), 'c', doneOf('b'));
    expect(placeLabel(place)).toBe('2 of 3');
    expect(place.previous?.key).toBe('a');
    expect(place.next?.key).toBe('d');
  });

  it('keeps a finished item between its neighbours ("Done · n left")', () => {
    const place = queuePlace(queue(), 'b', doneOf('b'));
    expect(placeLabel(place)).toBe('Done · 3 left');
    expect(place.previous?.key).toBe('a');
    expect(place.next?.key).toBe('c');
  });

  it('skipped items stay to do and are counted', () => {
    const place = queuePlace(queue({ skipped: ['a'] }), 'b', doneOf());
    expect(placeLabel(place)).toBe('2 of 4');
    expect(place.skipped).toBe(1);
    expect(place.previous?.key).toBe('a');
  });

  it('reads "Queue done" once every item is done, and the end state after Next on the last', () => {
    expect(placeLabel(queuePlace(queue(), 'd', doneOf('a', 'b', 'c', 'd')))).toBe('Queue done');
    const ended = queuePlace(queue({ finished: true, skipped: ['b', 'd'] }), 'd', doneOf('a', 'c'));
    expect(ended.finished).toBe(true);
    expect(placeLabel(ended)).toBe('End of queue · 2 skipped');
    const left = queuePlace(queue({ finished: true, skipped: ['d'] }), 'd', doneOf('a'));
    expect(placeLabel(left)).toBe('End of queue · 3 left');
  });

  it('an item the queue no longer lists starts Next at the first item to do', () => {
    const place = queuePlace(queue(), 'zz', doneOf('a'));
    expect(place.index).toBe(0);
    expect(place.next?.key).toBe('b');
    expect(placeLabel(place)).toBe('Not in queue · 3 left');
  });
});

describe('firstToDo and visit state', () => {
  it('finds the first open or skipped item', () => {
    expect(firstToDo(queue({ skipped: ['c'] }), doneOf('a'))?.key).toBe('b');
    expect(firstToDo(queue({ skipped: ['c'] }), doneOf('a'), true)?.key).toBe('c');
  });

  it('round-trips through history state and ignores anything else', () => {
    expect(visitOf(visitState({ id: 'q1', key: 'b' }))).toEqual({ id: 'q1', key: 'b' });
    expect(visitOf(null)).toBeNull();
    expect(visitOf({ queue: { state: null } })).toBeNull();
    expect(visitOf({ workThrough: { id: 1, key: 'b' } })).toBeNull();
  });
});
