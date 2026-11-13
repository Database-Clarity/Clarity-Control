// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { QueueItem, WorkQueue } from './model';
import { readStoredQueues, resetWorkQueues, useWorkQueues } from './store';

const items: QueueItem[] = ['a', 'b', 'c'].map((key, at) => ({ key, hash: at + 1, name: key }));
const queue = (id = 'q1', createdAt = 1): WorkQueue => ({
  version: 1,
  id,
  source: 'drift',
  scope: 'selected',
  origin: { path: '/drift', restore: { query: 'x', selected: [1, 2, 3] } },
  items,
  skipped: [],
  current: 'a',
  finished: false,
  createdAt,
  destination: null,
});

beforeEach(() => resetWorkQueues());

describe('work-through store', () => {
  it('skips an open item passed by Next, never one passed backwards', () => {
    const store = useWorkQueues.getState();
    store.start(queue());
    store.visit('q1', 'b', true);
    expect(useWorkQueues.getState().queues.q1!.skipped).toEqual(['a']);
    store.visit('q1', 'a', true);
    expect(useWorkQueues.getState().queues.q1!.skipped).toEqual(['a']);
    store.visit('q1', 'c', false);
    expect(useWorkQueues.getState().queues.q1!.skipped).toEqual(['a']);
    expect(useWorkQueues.getState().queues.q1!.current).toBe('c');
  });

  it('survives a reload: the session copy reads back the same', () => {
    const store = useWorkQueues.getState();
    store.start(queue());
    store.visit('q1', 'b', true);
    store.finish('q1', 'c', true);
    const reread = readStoredQueues();
    expect(reread.active).toBe('q1');
    expect(reread.queues.q1).toMatchObject({ current: 'c', finished: true, skipped: ['a', 'c'] });
  });

  it('Leave ends the tab’s queue but keeps it for Back; a visit makes it active again', () => {
    const store = useWorkQueues.getState();
    store.start(queue());
    store.end('q1');
    expect(useWorkQueues.getState().active).toBeNull();
    expect(useWorkQueues.getState().queues.q1).toBeDefined();
    store.visit('q1', 'a', false);
    expect(useWorkQueues.getState().active).toBe('q1');
  });

  it('rebuild replaces membership, keeps skipped items it still lists, and leaves the end state', () => {
    const store = useWorkQueues.getState();
    store.start(queue());
    store.visit('q1', 'b', true);
    store.finish('q1', 'b', true);
    store.rebuild('q1', [items[1]!, { key: 'd', hash: 4, name: 'd' }]);
    const rebuilt = useWorkQueues.getState().queues.q1!;
    expect(rebuilt.items.map((item) => item.key)).toEqual(['b', 'd']);
    expect(rebuilt.skipped).toEqual(['b']);
    expect(rebuilt.finished).toBe(false);
    expect(rebuilt.current).toBe('b');
  });

  it('keeps the five newest queues', () => {
    for (let at = 1; at <= 7; at++) useWorkQueues.getState().start(queue(`q${at}`, at));
    expect(Object.keys(useWorkQueues.getState().queues).sort()).toEqual([
      'q3',
      'q4',
      'q5',
      'q6',
      'q7',
    ]);
  });

  it('ignores unreadable session data', () => {
    sessionStorage.setItem('clarity-work-through:v1', '{not json');
    expect(readStoredQueues()).toEqual({ active: null, queues: {} });
  });
});
