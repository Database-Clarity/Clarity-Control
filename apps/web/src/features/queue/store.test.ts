// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('a step writes only the small record, never the frozen items; old queues drop theirs', () => {
    for (let at = 1; at <= 6; at++) useWorkQueues.getState().start(queue(`q${at}`, at));
    expect(sessionStorage.getItem('clarity-work-through:v1:items:q1')).toBeNull();
    expect(sessionStorage.getItem('clarity-work-through:v1:items:q6')).not.toBeNull();
    const frozen = sessionStorage.getItem('clarity-work-through:v1:items:q6')!;
    // A sentinel in the items key survives a step: the step never rewrites it.
    sessionStorage.setItem('clarity-work-through:v1:items:q6', JSON.stringify(['sentinel']));
    useWorkQueues.getState().visit('q6', 'b', true);
    expect(sessionStorage.getItem('clarity-work-through:v1:items:q6')).toBe('["sentinel"]');
    expect(sessionStorage.getItem('clarity-work-through:v1')).not.toContain('"items"');
    sessionStorage.setItem('clarity-work-through:v1:items:q6', frozen);
    expect(readStoredQueues().queues.q6!.current).toBe('b');
    expect(readStoredQueues().queues.q6!.items).toEqual(items);
  });

  it('ignores unreadable session data', () => {
    sessionStorage.setItem('clarity-work-through:v1', '{not json');
    expect(readStoredQueues()).toEqual({ active: null, queues: {} });
  });

  it.each(['{}', 'null', '[null]', '{bad json'])(
    'keeps valid queues when another batch queue has corrupt items: %s',
    (corrupt) => {
      vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
      try {
        useWorkQueues.getState().start(queue('valid'));
        useWorkQueues.getState().start({
          ...queue('broken'),
          source: 'translations',
          destination: {
            kind: 'batch',
            batchId: '01JF00000000000000000000AA',
            batchName: 'December patch',
          },
        });
        sessionStorage.setItem('clarity-work-through:v1:items:broken', corrupt);
        const restored = readStoredQueues();
        expect(Object.keys(restored.queues)).toEqual(['valid']);
        expect(restored.queues.valid).toEqual(queue('valid'));
        expect(restored.active).toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

it('restores only valid batch destinations while scheduled changes are enabled', () => {
  vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
  try {
    const batchId = '01JF00000000000000000000AA';
    const item = {
      key: 'batch:1:de',
      hash: 1,
      name: 'One',
      detail: { batchId, path: '/t/1?lang=de' },
    };
    const batchQueue = {
      ...queue(),
      source: 'translations' as const,
      items: [item],
      current: item.key,
      destination: { kind: 'batch' as const, batchId, batchName: 'December patch' },
    };
    useWorkQueues.getState().start(batchQueue);
    expect(readStoredQueues().queues.q1?.destination).toEqual(batchQueue.destination);
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
    expect(readStoredQueues().queues.q1).toBeUndefined();
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    useWorkQueues
      .getState()
      .start({ ...batchQueue, destination: { ...batchQueue.destination, batchId: 'bad' } });
    expect(readStoredQueues().queues.q1).toBeUndefined();
    useWorkQueues
      .getState()
      .start({ ...batchQueue, items: [{ ...item, detail: { batchId: 'wrong' } }] });
    expect(readStoredQueues().queues.q1).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});
