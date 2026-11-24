import { groupPublishes } from './publishStatus';
import { expect, it } from 'vitest';
import type { PublishOp } from '../../services/publisher/opStore';
import { hashList, publishTiming } from './publishDriver';
import { describeOp, foreignWaiting } from './publishStatus';

const base: PublishOp = {
  opId: '01M6GMFKG0JPP01N49ZMR9Z9TS',
  userId: '1',
  createdAt: 1_000_000,
  hashes: [1, 2, 3],
  expected: {},
  previous: {},
  status: 'created',
  updatedAt: 1_000_000,
};
const view = (patch: Partial<PublishOp>, now = base.createdAt + 1000, note?: string) =>
  describeOp({ ...base, ...patch }, note, now, (ms) => `@${ms}`);

it('words every status, and says plainly when nothing went live', () => {
  expect(view({}).chip).toBe('Sending…');
  expect(view({ status: 'pending' }).chip).toBe('Queued');
  expect(view({ status: 'done' })).toMatchObject({ chip: 'Published', tone: 'ok', finished: true });
  expect(view({ status: 'unchanged' }).chip).toBe('Already live');
  expect(view({ status: 'stale' })).toMatchObject({ chip: 'Changed', tone: 'warn' });
  expect(view({ status: 'stale' }).detail).toContain('Nothing from this request went live');
  expect(view({ status: 'rejected' })).toMatchObject({ chip: 'Rejected', tone: 'bad' });
  expect(view({ status: 'failed' })).toMatchObject({ chip: 'Failed', tone: 'bad' });
  expect(view({ status: 'failed', error: 'Dropped.' }).detail).toBe('Dropped.');
  expect(view({ status: 'pending' }).lead).toBe('3 tooltips');
});

it('turns a pending operation into Waiting (with Retry) after three minutes, and a note wins the detail', () => {
  const early = view({ status: 'pending', acceptedAt: base.createdAt }, base.createdAt + 60_000);
  expect(early.waiting).toBe(false);
  const late = view(
    { status: 'pending', acceptedAt: base.createdAt },
    base.createdAt + publishTiming.waitingMs,
  );
  expect(late).toMatchObject({ waiting: true, chip: 'Waiting' });
  expect(view({}, base.createdAt, 'Offline; retrying.').detail).toBe('Offline; retrying.');
  expect(view({ status: 'done' }).waiting).toBe(false);
});

it("counts only other people's old, valid queue entries", () => {
  const now = Date.parse('2026-11-03T12:30:00Z');
  const old = '2026-11-03T12:00:00Z';
  const queue = [
    { opId: 'A', requester: { id: 2, login: 'x' }, hashes: [1], createdAt: old },
    { opId: 'B', requester: { id: 3, login: 'y' }, hashes: [1], createdAt: '2026-11-03T12:29:00Z' },
    { opId: 'C', requester: { id: 4, login: 'z' }, hashes: [1], createdAt: '2026-11-03T11:00:00Z' },
    { opId: 'D', invalid: true as const },
    { opId: 'MINE', requester: { id: 1, login: 'me' }, hashes: [1], createdAt: old },
  ];
  expect(foreignWaiting(queue, new Set(['MINE']), now)).toEqual({
    count: 2,
    since: Date.parse('2026-11-03T11:00:00Z'),
    opId: 'C',
  });
  expect(foreignWaiting(undefined, new Set(), now)).toBeUndefined();
  expect(foreignWaiting([queue[1]!], new Set(), now)).toBeUndefined();
});

it('aggregates partial success as pending, then incomplete when another chunk fails', () => {
  const base = {
    opId: 'A',
    groupId: 'A',
    userId: '1',
    createdAt: 1,
    updatedAt: 1,
    hashes: [1],
    expected: {},
    previous: {},
    status: 'done' as const,
  };
  const pending = { ...base, opId: 'B', hashes: [2], status: 'pending' as const };
  expect(groupPublishes([base, pending])[0]!).toMatchObject({
    op: { status: 'pending' },
    liveCount: 1,
  });
  const failed = groupPublishes([base, { ...pending, status: 'stale' }])[0]!.op;
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('1 of 2 tooltips confirmed live');
  const done = groupPublishes([base, { ...pending, status: 'done', updatedAt: 67_001 }])[0]!.op;
  expect(describeOp(done, undefined, 68_000, String).detail).toBe('Confirmed live after 1:07.');
});

it("PUBLISH-502: a grouped failure keeps the first failed part's own reason", () => {
  const base = {
    opId: 'A',
    groupId: 'A',
    groupSize: 3,
    userId: '1',
    createdAt: 1,
    updatedAt: 1,
    hashes: [1, 2],
    expected: {},
    previous: {},
    status: 'failed' as const,
    error:
      'Worker error (HTTP 502: GitHub batch read failed); the Worker holds no request for these tooltips. Publish again later, or report this error.',
  };
  const all = groupPublishes([base, { ...base, opId: 'B' }, { ...base, opId: 'C', hashes: [3] }]);
  expect(all[0]!.op.error).toBe(
    `Publish incomplete: 0 of 5 tooltips confirmed live. First failed part (2 tooltips): ${base.error} Check live status before publishing again.`,
  );
  // Mixed: one part went live; the reason names only the failed part, never the whole group.
  const mixed = groupPublishes([
    { ...base, status: 'done' as const, error: undefined },
    { ...base, opId: 'B', hashes: [3] },
    { ...base, opId: 'C', hashes: [4], status: 'unchanged' as const, error: undefined },
  ])[0]!.op;
  expect(mixed.status).toBe('failed');
  expect(mixed.error).toMatch(
    /^Publish incomplete: 3 of 4 tooltips confirmed live\. First failed part \(1 tooltips\): Worker error \(HTTP 502: GitHub batch read failed\)/,
  );
});

it('offers Retry only for a queued part, and keeps long final reasons whole', () => {
  const part = {
    opId: 'A',
    groupId: 'A',
    groupHashCount: 2,
    round: 1,
    userId: '1',
    createdAt: 1,
    updatedAt: 1,
    hashes: [1],
    expected: {},
    previous: {},
    status: 'done' as const,
  };
  const now = 10 * publishTiming.waitingMs;
  const describe = (members: PublishOp[]) => {
    const group = groupPublishes(members)[0]!;
    return describeOp(group.op, undefined, now, String, group.checking);
  };
  // Still sending: nothing the Worker could kick yet.
  expect(describe([part, { ...part, opId: 'B', hashes: [2], status: 'created' }])).toMatchObject({
    chip: 'Sending…',
    waiting: false,
  });
  // Queued long ago: Retry kicks it. Accepted just now: not waiting yet.
  const queued = { ...part, opId: 'B', hashes: [2], status: 'pending' as const, acceptedAt: 1 };
  expect(describe([part, queued]).waiting).toBe(true);
  expect(describe([part, { ...queued, acceptedAt: now - 1000 }]).waiting).toBe(false);
  // Every part finished, one receipt unread: the real state, no Retry.
  const unread = { ...part, opId: 'B', hashes: [2], status: 'rejected' as const };
  expect(describe([part, unread])).toMatchObject({ chip: 'Checking…', waiting: false });

  // Five refused 50-row parts with ten-digit hashes: every sentence and the reason survive.
  const refusedParts = Array.from({ length: 5 }, (_, index) => {
    const hashes = Array.from({ length: 50 }, (__, i) => 3_000_000_000 + index * 50 + i);
    return {
      ...part,
      opId: `P${index}`,
      hashes,
      groupHashCount: 250,
      consumers: 400,
      status: 'rejected' as const,
      receiptChecked: true as const,
      refusal: 'Missing export "Charge"',
      error: `Tooltips ${hashList(hashes)}: Missing export "Charge"`,
    };
  });
  const final = describe(refusedParts);
  expect(final.chip).toBe('Failed');
  expect(final.detail).toContain('3000000009 and 40 more: Missing export "Charge"');
  expect(final.detail).toContain('2 more parts were refused.');
  expect(final.detail.endsWith('Check live status before publishing again.')).toBe(true);
  expect(final.detail.length).toBeLessThan(800);
});

it('never labels an incomplete local group as published', () => {
  const only = {
    opId: 'A',
    groupId: 'A',
    groupSize: 2,
    userId: '1',
    createdAt: 1,
    updatedAt: 1,
    hashes: [1],
    expected: {},
    previous: {},
    status: 'done' as const,
  };
  expect(groupPublishes([only])[0]!.op.status).toBe('failed');
});
