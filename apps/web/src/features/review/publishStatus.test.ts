import { groupPublishes } from './publishStatus';
import { expect, it } from 'vitest';
import type { PublishOp } from '../../services/publisher/opStore';
import { publishTiming } from './publishDriver';
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
  expect(view({ status: 'pending' }).chip).toBe('Publishing…');
  expect(view({ status: 'done' })).toMatchObject({ chip: 'Published', tone: 'ok', finished: true });
  expect(view({ status: 'unchanged' }).chip).toBe('Already live');
  expect(view({ status: 'stale' })).toMatchObject({ chip: 'Changed', tone: 'warn' });
  expect(view({ status: 'stale' }).detail).toContain('Nothing from this request went live');
  expect(view({ status: 'rejected' })).toMatchObject({ chip: 'Rejected', tone: 'bad' });
  expect(view({ status: 'failed' })).toMatchObject({ chip: 'Failed', tone: 'bad' });
  expect(view({ status: 'failed', error: 'Dropped.' }).detail).toBe('Dropped.');
  expect(view({ status: 'pending' }).lead).toBe('3 tooltips · @1000000');
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
  expect(groupPublishes([base, pending])[0]!.op.status).toBe('pending');
  const failed = groupPublishes([base, { ...pending, status: 'stale' }])[0]!.op;
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('1 of 2 tooltips confirmed live');
  expect(groupPublishes([base, { ...pending, status: 'done' }])[0]!.op.status).toBe('done');
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
