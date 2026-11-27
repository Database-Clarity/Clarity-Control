import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PublishHttpError, type RemoteStatus } from '../../services/publisher/api';
import { createMemoryOpStore, type PublishOp } from '../../services/publisher/opStore';
import { describeOp } from './publishStatus';
import {
  activeHashes,
  PublishDriver,
  publishTiming,
  usePublishState,
  type DriverDeps,
  type PublishApi,
} from './publishDriver';
import { attentionText, needsAttention } from './publishAttention';

const digest = (n: number) => String(n).repeat(64).slice(0, 64);
const inputs = Array.from({ length: 148 }, (_, i) => ({
  hash: 1000 + i,
  digest: digest((i % 9) + 1),
  previous: undefined,
  name: `Row ${1000 + i}`,
}));
const when = (ms: number) => new Date(ms).toISOString();

function make(store = createMemoryOpStore(), wholeSelection = true) {
  const api = {
    post: vi.fn<PublishApi['post']>(async () => ({ status: 'pending' })),
    postTranslations: vi.fn<PublishApi['postTranslations']>(async () => ({ status: 'pending' })),
    translationStatus: vi.fn<PublishApi['translationStatus']>(async () => ({ status: 'pending' })),
    status: vi.fn<PublishApi['status']>(async () => 'pending' as RemoteStatus | 'unknown'),
    kick: vi.fn<PublishApi['kick']>(async () => undefined),
    ack: vi.fn<NonNullable<PublishApi['ack']>>(async () => undefined),
  };
  const acknowledged: PublishOp[] = [];
  const deps: DriverDeps = {
    store,
    api,
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    visible: () => true,
    broadcast: () => undefined,
    acknowledge: (op) => acknowledged.push(op),
    wholeSelection,
  };
  return { driver: new PublishDriver(deps), api, store, acknowledged };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const ops = () => usePublishState.getState().ops;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

it('sends 148 rows as one stored whole request and reads "Publishing, safe to close" at 202', async () => {
  const { driver, api, store } = make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  expect(api.post).toHaveBeenCalledTimes(1);
  const body = api.post.mock.calls[0]![0];
  expect(body).toMatchObject({ opId: created.opId, selection: 'whole' });
  expect(body.hashes).toHaveLength(148);
  expect(store.records.get(created.opId)).toMatchObject({ whole: true, status: 'pending' });
  expect(ops()).toHaveLength(1);
  const view = describeOp(ops()[0]!, undefined, Date.now(), when);
  expect([view.chip, view.detail]).toEqual(['Publishing', 'Publishing, safe to close.']);
  // Still queued after the waiting threshold.
  const later = describeOp(ops()[0]!, undefined, Date.now() + publishTiming.waitingMs, when);
  expect(later.detail).toMatch(/^Publish is still queued/);
});

it('says it is checking after a lost reply, and resends the same id and body', async () => {
  const { driver, api } = make();
  await driver.start('1');
  api.post.mockRejectedValueOnce(new PublishHttpError(0, 'Network error'));
  const created = await driver.create(inputs.slice(0, 3));
  await settle();
  expect(usePublishState.getState().notes[created.opId]).toBe(
    'Checking whether the publish was received.',
  );
  expect(describeOp(ops()[0]!, undefined, Date.now(), when).detail).toBe(
    'Sending publish request…',
  );
  await vi.advanceTimersByTimeAsync(publishTiming.sendBackoffMs(0) + 1);
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post.mock.calls[1]![0]).toEqual(api.post.mock.calls[0]![0]);
  expect(ops()[0]!.status).toBe('pending');
});

it('names the held rows, acknowledges only the rest, frees the held rows, and acks on dismiss', async () => {
  const { driver, api, acknowledged } = make();
  await driver.start('1');
  const created = await driver.create(inputs.slice(0, 3));
  await settle();
  api.status.mockResolvedValue('done');
  api.post.mockResolvedValue({
    status: 'done',
    held: [{ hash: 1001, reason: 'Saved text changed after review.' }],
  });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 1);
  const finished = ops()[0]!;
  expect(finished).toMatchObject({
    status: 'done',
    held: [{ hash: 1001, name: 'Row 1001', reason: 'Saved text changed after review.' }],
  });
  expect(acknowledged.map(({ opId }) => opId)).toEqual([created.opId]);
  expect(activeHashes(ops()).size).toBe(0);
  const view = describeOp(finished, undefined, Date.now(), when);
  expect(view.chip).toBe('Partly live');
  expect(view.detail).toBe(
    'Not published: Row 1001 (Saved text changed after review). The rest is live.',
  );
  await driver.dismiss(created.opId);
  expect(api.ack).toHaveBeenCalledWith(created.opId);
});

it('reports a publisher without one-request publishes and sends nothing else', async () => {
  const { driver, api } = make();
  await driver.start('1');
  api.post.mockRejectedValueOnce(
    new PublishHttpError(
      409,
      'Update the installed publisher before publishing in one request.',
      true,
      'whole-selection-unavailable',
    ),
  );
  await driver.create(inputs.slice(0, 2));
  await settle();
  expect(ops()[0]).toMatchObject({
    status: 'failed',
    error: 'Update the installed publisher before publishing in one request.',
  });
  expect(describeOp(ops()[0]!, undefined, Date.now(), when).detail).toBe(
    'Update the installed publisher before publishing in one request.',
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('still resumes a stored grouped publish from the previous client', async () => {
  const store = createMemoryOpStore();
  const old = make(store, false);
  await old.driver.start('1');
  await old.driver.create(
    Array.from({ length: 60 }, (_, i) => ({
      hash: 2000 + i,
      digest: digest(1),
      previous: undefined,
    })),
  );
  await settle();
  old.driver.stop();
  const grouped = [...store.records.values()];
  expect(grouped).toHaveLength(2);
  expect(grouped.every((op) => op.groupId && !op.whole)).toBe(true);
  const next = make(store);
  next.api.status.mockResolvedValue('done');
  await next.driver.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 1);
  expect([...store.records.values()].map(({ status }) => status)).toEqual(['done', 'done']);
  expect(next.api.post).not.toHaveBeenCalled();
});

it('words the shell notice for one or several publishes that need attention', () => {
  const entry = {
    opId: '01MBZ000000000000000000001',
    createdAt: '2026-11-26T12:00:00.000Z',
    rows: 148,
    globals: 0,
    status: 'done' as const,
    held: 2,
  };
  expect(needsAttention(entry)).toBe(true);
  expect(needsAttention({ ...entry, held: 0 })).toBe(false);
  expect(needsAttention({ ...entry, held: 0, status: 'pending' })).toBe(false);
  expect(attentionText([entry])).toBe(
    'Publish needs attention: 2 of 148 changes were held back. The rest is live.',
  );
  expect(attentionText([{ ...entry, held: 0, status: 'rejected' }])).toBe(
    'Publish needs attention: nothing from a publish of 148 changes went live.',
  );
  expect(attentionText([entry, entry])).toBe(
    'Publish needs attention: 2 publishes did not fully go live.',
  );
});

it('keeps checking a whole request after a day and finishes it from its receipt', async () => {
  const { driver, api } = make();
  await driver.start('1');
  await driver.create(inputs.slice(0, 2));
  await settle();
  expect(ops()[0]!.status).toBe('pending');
  await vi.advanceTimersByTimeAsync(publishTiming.pollGiveUpMs + 1);
  api.status.mockResolvedValue('done');
  api.post.mockResolvedValue({ status: 'done' });
  await vi.advanceTimersByTimeAsync(publishTiming.slowPollMs + 1);
  expect(ops()[0]!.status).toBe('done');
});

it('ends the result read on a definitive refusal and refreshes the role on 403', async () => {
  const { driver, api } = make();
  const forbidden = vi.fn();
  (driver as unknown as { deps: DriverDeps }).deps.forbidden = forbidden;
  await driver.start('1');
  await driver.create(inputs.slice(0, 2));
  await settle();
  api.status.mockResolvedValue('rejected');
  api.post.mockRejectedValue(new PublishHttpError(403, 'Permission denied', true));
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 1);
  const finished = ops()[0]!;
  expect(finished).toMatchObject({ status: 'rejected', receiptChecked: true });
  expect(forbidden).toHaveBeenCalled();
  const posts = api.post.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(api.post.mock.calls.length).toBe(posts);
  expect(describeOp(finished, undefined, Date.now(), when).chip).toBe('Attention');
});

it('never reads an unreadable held list as all live', async () => {
  const { driver, api, acknowledged } = make();
  await driver.start('1');
  await driver.create(inputs.slice(0, 2));
  await settle();
  api.status.mockResolvedValue('done');
  api.post.mockResolvedValue({
    status: 'failed',
    refusal: 'The publish finished, but which tooltips it held could not be read.',
  });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 1);
  expect(ops()[0]).toMatchObject({
    status: 'failed',
    error: 'The publish finished, but which tooltips it held could not be read.',
  });
  expect(acknowledged).toEqual([]);
});

it('keeps a whole request that needs attention past the retention day until dismissed', async () => {
  const { driver, api, store } = make();
  await driver.start('1');
  const created = await driver.create(inputs.slice(0, 2));
  await settle();
  api.status.mockResolvedValue('done');
  api.post.mockResolvedValue({ status: 'done', held: [{ hash: 1000, reason: 'Changed.' }] });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 1);
  await vi.advanceTimersByTimeAsync(publishTiming.retainMs + 60_000);
  await driver.refresh();
  expect(store.records.has(created.opId)).toBe(true);
  expect(ops().map(({ opId }) => opId)).toEqual([created.opId]);
});
