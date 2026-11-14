import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PublishHttpError, type RemoteStatus } from '../../services/publisher/api';
import { createMemoryOpStore, type OpStore } from '../../services/publisher/opStore';
import {
  PublishDriver,
  publishTiming,
  usePublishState,
  type DriverDeps,
  type PublishApi,
} from './publishDriver';

const digest = (n: number) => String(n).repeat(64).slice(0, 64);
const inputs = [
  { hash: 20, digest: digest(2), previous: undefined },
  { hash: 10, digest: digest(1), previous: 'old' },
];

interface Harness {
  store: ReturnType<typeof createMemoryOpStore>;
  api: {
    post: ReturnType<typeof vi.fn<PublishApi['post']>>;
    status: ReturnType<typeof vi.fn<PublishApi['status']>>;
    kick: ReturnType<typeof vi.fn<PublishApi['kick']>>;
  };
  log: string[];
  acked: string[];
  visible: boolean;
  make(userId?: string): PublishDriver;
}

function harness(store = createMemoryOpStore()): Harness {
  const log: string[] = [];
  const api: Harness['api'] = {
    post: vi.fn(async () => ({ status: 'pending' as const })),
    status: vi.fn(async () => 'pending' as RemoteStatus | 'unknown'),
    kick: vi.fn(async () => undefined),
  };
  const h: Harness = {
    store,
    api,
    log,
    acked: [],
    visible: true,
    make() {
      const tracked: OpStore = {
        ...store,
        add: async (op) => {
          log.push('store.add');
          return store.add(op);
        },
      };
      const deps: DriverDeps = {
        store: tracked,
        api,
        now: () => Date.now(),
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        visible: () => h.visible,
        broadcast: () => undefined,
        acknowledge: (op) => h.acked.push(op.opId),
      };
      api.post.mockImplementation(async (body) => {
        log.push(`post ${body.opId}`);
        return { status: 'pending' as const };
      });
      return new PublishDriver(deps);
    },
  };
  return h;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const ops = () => usePublishState.getState().ops;
const op = () => ops()[0]!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

it('stores the operation before the first request and sends hashes with the reviewed digests', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  expect(h.log[0]).toBe('store.add');
  expect(h.log[1]).toBe(`post ${created.opId}`);
  expect(h.api.post).toHaveBeenCalledWith({
    opId: created.opId,
    hashes: [10, 20],
    expected: { 10: digest(1), 20: digest(2) },
  });
  expect(op().status).toBe('pending');
  expect(h.store.records.get(created.opId)?.previous).toEqual({ 10: 'old', 20: null });
});

it('a lost 202 resends the same opId and body, never a new one', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const lost = h.api.post;
  let calls = 0;
  lost.mockImplementation(async () => {
    calls++;
    if (calls < 3) throw new PublishHttpError(0, 'Failed to fetch');
    return { status: 'pending' as const };
  });
  const created = await driver.create(inputs);
  await settle();
  expect(op().status).toBe('created');
  expect(usePublishState.getState().notes[created.opId]).toMatch(/Offline/);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toBe(3);
  expect(new Set(lost.mock.calls.map(([body]) => body.opId))).toEqual(new Set([created.opId]));
  expect(new Set(lost.mock.calls.map(([body]) => JSON.stringify(body))).size).toBe(1);
  expect(op().status).toBe('pending');
});

it('retries 5xx and 429 with backoff, but gives up on a definite rejection', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockRejectedValueOnce(new PublishHttpError(503, 'unresolved'));
  const created = await driver.create(inputs);
  await settle();
  expect(op().status).toBe('created');
  await vi.advanceTimersByTimeAsync(publishTiming.sendBackoffMs(0) + 100);
  expect(op().status).toBe('pending');
  // A 422-style rejection is final.
  h.api.post.mockRejectedValueOnce(new PublishHttpError(422, 'nope'));
  await driver.create([{ hash: 30, digest: digest(3), previous: undefined }]);
  await settle();
  expect(ops().find((o) => o.hashes[0] === 30)?.status).toBe('failed');
  expect(created.opId).not.toBe(ops()[1]!.opId);
});

it("PUBLISH-502: a Worker's own 502 shows its message, then fails once the Worker has no record", async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockRejectedValue(new PublishHttpError(502, 'GitHub batch read failed', true));
  h.api.status.mockResolvedValue('unknown');
  const created = await driver.create(inputs);
  await settle();
  expect(op().status).toBe('created');
  expect(usePublishState.getState().notes[created.opId]).toBe(
    'Worker error (HTTP 502: GitHub batch read failed); retrying.',
  );
  expect(h.api.status).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(
    publishTiming.sendBackoffMs(0) + publishTiming.sendBackoffMs(1) + 200,
  );
  expect(h.api.post).toHaveBeenCalledTimes(publishTiming.workerErrorAttempts);
  expect(h.api.status).toHaveBeenCalledWith(created.opId);
  expect(op().status).toBe('failed');
  expect(op().error).toMatch(/HTTP 502: GitHub batch read failed.*holds no request/);
  // Finished: no further resends.
  await vi.advanceTimersByTimeAsync(300_000);
  expect(h.api.post).toHaveBeenCalledTimes(publishTiming.workerErrorAttempts);
});

it('PUBLISH-502: a Worker 502 after a landed create adopts the pending request instead of failing', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockRejectedValue(new PublishHttpError(502, 'GitHub batch read failed', true));
  h.api.status.mockResolvedValue('pending');
  await driver.create(inputs);
  await settle();
  await vi.advanceTimersByTimeAsync(
    publishTiming.sendBackoffMs(0) + publishTiming.sendBackoffMs(1) + 200,
  );
  expect(op().status).toBe('pending');
});

/** Drives one operation to its third Worker 502, with the status lookup held open. */
async function heldThirdAttempt(h: Harness, driver: PublishDriver) {
  let answer!: (value: RemoteStatus | 'unknown') => void;
  let refuse!: (reason: unknown) => void;
  h.api.post.mockRejectedValue(new PublishHttpError(502, 'GitHub batch read failed', true));
  h.api.status.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      }),
  );
  const created = await driver.create(inputs);
  await vi.advanceTimersByTimeAsync(
    publishTiming.sendBackoffMs(0) + publishTiming.sendBackoffMs(1) + 200,
  );
  expect(h.api.status).toHaveBeenCalledTimes(1);
  return {
    created,
    answer: (v: RemoteStatus | 'unknown') => answer(v),
    refuse: (r: unknown) => refuse(r),
  };
}

it('PUBLISH-502: a status reply from before a same-account restart never settles the resent publish', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const held = await heldThirdAttempt(h, driver);
  // A token refresh restarts the driver for the same account; its resend is accepted.
  h.api.post.mockReset();
  h.api.post.mockResolvedValue({ status: 'pending' as const });
  h.api.status.mockReset();
  h.api.status.mockResolvedValue('pending');
  await driver.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 100);
  expect(op().status).toBe('pending');
  held.answer('unknown');
  await settle();
  expect(op().status).toBe('pending');
  expect(h.store.records.get(held.created.opId)?.status).toBe('pending');
});

it('PUBLISH-502: a late "unknown" never fails a record another tab already stored as pending', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const held = await heldThirdAttempt(h, driver);
  // Another tab's resend of the same opId landed and stored `pending`.
  await h.store.update(held.created.opId, (op) => ({
    ...op,
    status: 'pending',
    acceptedAt: Date.now(),
  }));
  h.api.status.mockReset();
  h.api.status.mockResolvedValue('pending');
  held.answer('unknown');
  await settle();
  expect(h.store.records.get(held.created.opId)?.status).toBe('pending');
  expect(op().status).toBe('pending');
  expect(op().error).toBeUndefined();
});

it('PUBLISH-502: a status reply from before an account switch has no effect on either account', async () => {
  for (const outcome of ['unknown', 'done', 'pending', 'reject'] as const) {
    const h = harness();
    const driver = h.make();
    await driver.start('1');
    const held = await heldThirdAttempt(h, driver);
    await driver.start('2');
    if (outcome === 'reject') held.refuse(new PublishHttpError(502, 'late', true));
    else held.answer(outcome);
    await settle();
    expect(h.acked, outcome).toEqual([]);
    expect(usePublishState.getState().notes, outcome).toEqual({});
    expect(usePublishState.getState().ops, outcome).toEqual([]);
    expect(h.store.records.get(held.created.opId)?.status, outcome).toBe('created');
    driver.stop();
  }
});

it('PUBLISH-502: edge 5xx pages, Worker 503s, and an unreachable status check keep retrying', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  // An edge 502 page has no Worker message: still "busy", never failed by count.
  h.api.post.mockRejectedValue(new PublishHttpError(502, '<html>Bad gateway</html>'));
  const created = await driver.create(inputs);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(op().status).toBe('created');
  expect(usePublishState.getState().notes[created.opId]).toBe('Worker busy (HTTP 502); retrying.');
  expect(h.api.status).not.toHaveBeenCalled();
  // The Worker's 503 means "retry the same opId".
  h.api.post.mockRejectedValue(new PublishHttpError(503, 'Publish create unresolved', true));
  await vi.advanceTimersByTimeAsync(200_000);
  expect(op().status).toBe('created');
  expect(h.api.status).not.toHaveBeenCalled();
  // A Worker 502 whose status check also fails cannot prove nothing was queued: keep retrying.
  h.api.post.mockRejectedValue(new PublishHttpError(502, 'GitHub batch read failed', true));
  h.api.status.mockRejectedValue(new PublishHttpError(502, 'GitHub batch read failed', true));
  await vi.advanceTimersByTimeAsync(200_000);
  expect(h.api.status).toHaveBeenCalled();
  expect(op().status).toBe('created');
  expect(usePublishState.getState().notes[created.opId]).toMatch(/^Worker error \(HTTP 502/);
});

it('resumes a stored operation after a reload with the same opId and body', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  h.api.post.mockRejectedValue(new PublishHttpError(0, 'offline'));
  const created = await first.create(inputs);
  await settle();
  first.stop();
  // New "page load": a fresh driver over the same storage.
  h.api.post.mockReset();
  h.api.post.mockResolvedValue({ status: 'pending' as const });
  const second = h.make();
  await second.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 100);
  expect(h.api.post).toHaveBeenCalledTimes(1);
  expect(h.api.post.mock.calls[0]![0]).toEqual({
    opId: created.opId,
    hashes: [10, 20],
    expected: { 10: digest(1), 20: digest(2) },
  });
  expect(ops()).toHaveLength(1);
  expect(op().status).toBe('pending');
});

it("does not resume another account's operations", async () => {
  const h = harness();
  const a = h.make();
  await a.start('1');
  await a.create(inputs);
  await settle();
  a.stop();
  const b = h.make();
  await b.start('2');
  expect(ops()).toEqual([]);
  expect(h.api.post).toHaveBeenCalledTimes(1);
});

it.each([
  ['done', true],
  ['unchanged', true],
  ['stale', false],
  ['rejected', false],
  ['failed', false],
] as const)('status %s from polling: acknowledged=%s', async (status, acknowledged) => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  h.api.status.mockResolvedValue(status);
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(op().status).toBe(status);
  expect(h.acked).toEqual(acknowledged ? [created.opId] : []);
  // Terminal means no more polling and no resends.
  const polls = h.api.status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(h.api.status.mock.calls.length).toBe(polls);
  expect(h.api.post).toHaveBeenCalledTimes(1);
});

it('adopts an already-finished answer to the POST itself (duplicate or lost-202 retry)', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockResolvedValue({ status: 'stale' });
  await driver.create(inputs);
  await settle();
  expect(op().status).toBe('stale');
  expect(h.acked).toEqual([]);
});

it('a 400 asks for the status instead of making a new opId, then reports the clock', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockRejectedValue(new PublishHttpError(400, 'Publish opId outside creation window'));
  h.api.status.mockResolvedValue('unknown');
  const created = await driver.create(inputs);
  await settle();
  expect(h.api.status).toHaveBeenCalledWith(created.opId);
  expect(op().status).toBe('failed');
  expect(op().error).toMatch(/device clock/);
  expect(h.api.post).toHaveBeenCalledTimes(1);
  // But if the Worker does know it, that answer wins.
  h.api.status.mockResolvedValue('done');
  const second = await driver.create([{ hash: 5, digest: digest(5), previous: undefined }]);
  await settle();
  expect(ops().find((o) => o.opId === second.opId)?.status).toBe('done');
});

it('pauses on 401 and resumes after the account signs in again', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockRejectedValueOnce(new PublishHttpError(401, 'expired'));
  await driver.create(inputs);
  await settle();
  expect(usePublishState.getState().notes[op().opId]).toMatch(/Sign in again/);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(h.api.post).toHaveBeenCalledTimes(1);
  await driver.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 100);
  expect(h.api.post).toHaveBeenCalledTimes(2);
  expect(op().status).toBe('pending');
});

it('a pending operation the Worker no longer knows is resent, not dropped', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  await driver.create(inputs);
  await settle();
  h.api.status.mockResolvedValueOnce('unknown');
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(h.api.post).toHaveBeenCalledTimes(2);
  expect(op().status).toBe('pending');
});

it('polls cheaply: bounded requests over ten minutes, none while the tab is hidden', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  await driver.create(inputs);
  await settle();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  // 4 s polls for 30 s, 10 s until 3 min, then 30 s: well under 40 requests for ten minutes.
  expect(h.api.status.mock.calls.length).toBeGreaterThan(8);
  expect(h.api.status.mock.calls.length).toBeLessThan(40);
  const before = h.api.status.mock.calls.length;
  h.visible = false;
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(h.api.status.mock.calls.length).toBe(before);
});

it('auto-kicks exactly once after three minutes, across reloads', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs - 5_000);
  expect(h.api.kick).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.api.kick).toHaveBeenCalledTimes(1);
  expect(h.api.kick).toHaveBeenCalledWith(created.opId);
  driver.stop();
  const again = h.make();
  await again.start('1');
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(h.api.kick).toHaveBeenCalledTimes(1);
});

it('two tabs share one poll stream and one auto-kick', async () => {
  const h = harness();
  const tabA = h.make();
  await tabA.start('1');
  await tabA.create(inputs);
  await settle();
  const tabB = h.make();
  await tabB.start('1');
  // Same storage, same clock: every poll/kick slot is claimed by exactly one of them.
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs + 60_000);
  expect(h.api.kick).toHaveBeenCalledTimes(1);
  const together = h.api.status.mock.calls.length;
  tabA.stop();
  tabB.stop();
  const single = harness();
  const solo = single.make();
  await solo.start('1');
  await solo.create(inputs);
  await settle();
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs + 60_000);
  expect(together).toBeLessThanOrEqual(single.api.status.mock.calls.length + 2);
});

it('manual Retry kicks, but not more than once per gap', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  await driver.kickWaiting(created.opId);
  await driver.kickWaiting(created.opId);
  expect(h.api.kick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(publishTiming.manualKickGapMs + 100);
  await driver.kickWaiting(created.opId);
  expect(h.api.kick).toHaveBeenCalledTimes(2);
});

it('a kick answered "not pending" re-checks the status at once', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  h.api.kick.mockRejectedValue(new PublishHttpError(409, 'Publish request is not pending'));
  h.api.status.mockResolvedValue('done');
  await driver.kickWaiting(created.opId);
  expect(op().status).toBe('done');
});

it('rebuilds acknowledgments from finished operations after a reload, once', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  const created = await first.create(inputs);
  h.api.status.mockResolvedValue('done');
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(h.acked).toEqual([created.opId]);
  first.stop();
  const second = h.make();
  await second.start('1');
  expect(h.acked).toEqual([created.opId, created.opId]); // tab memory was lost: rebuilt on load
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.acked).toHaveLength(2); // and never re-applied afterwards
});

it('dismiss hides a finished operation (but keeps it for the acknowledgment), never a running one', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  await driver.dismiss(created.opId);
  expect(ops()).toHaveLength(1);
  h.api.status.mockResolvedValue('stale');
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  await driver.dismiss(created.opId);
  expect(ops()).toHaveLength(0);
  expect(h.store.records.get(created.opId)?.dismissed).toBe(true);
});

it('prunes finished operations after a day', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.status.mockResolvedValue('failed');
  const done = await driver.create(inputs);
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  driver.stop();
  vi.setSystemTime(Date.now() + publishTiming.retainMs + 1000);
  await h.make().start('1');
  expect(h.store.records.has(done.opId)).toBe(false);
});

// A lost 202, then the page is reloaded after the creation window: the Worker, not the clock,
// decides what happened to the original opId.
async function lostThenOvernight(h: Harness) {
  const first = h.make();
  await first.start('1');
  h.api.post.mockRejectedValue(new PublishHttpError(0, 'offline'));
  const created = await first.create(inputs);
  await settle();
  first.stop();
  vi.setSystemTime(Date.now() + publishTiming.sendExpiryMs + 1000);
  const second = h.make();
  h.api.post.mockClear();
  await second.start('1');
  return created;
}

it.each(['done', 'unchanged', 'stale', 'pending'] as const)(
  'an old unconfirmed operation adopts the Worker answer (%s) and is never re-posted',
  async (remote) => {
    const h = harness();
    h.api.status.mockResolvedValue(remote);
    const created = await lostThenOvernight(h);
    await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 1000);
    expect(h.api.status).toHaveBeenCalledWith(created.opId);
    expect(h.store.records.get(created.opId)?.status).toBe(remote);
    expect(h.api.post).not.toHaveBeenCalled();
    expect(h.acked.length).toBe(remote === 'done' || remote === 'unchanged' ? 1 : 0);
  },
);

it('an old unconfirmed operation stays unresolved while the status lookup fails, then fails only on "unknown"', async () => {
  const h = harness();
  h.api.status.mockRejectedValue(new PublishHttpError(503, 'busy'));
  const created = await lostThenOvernight(h);
  await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 1000);
  expect(h.store.records.get(created.opId)?.status).toBe('created');
  expect(usePublishState.getState().notes[created.opId]).toMatch(/Could not confirm/);
  expect(h.api.post).not.toHaveBeenCalled();
  h.api.status.mockResolvedValue('unknown');
  await vi.advanceTimersByTimeAsync(publishTiming.sendBackoffMs(9) + 1000);
  expect(h.store.records.get(created.opId)?.status).toBe('failed');
  expect(h.store.records.get(created.opId)?.error).toMatch(/no record/);
  expect(h.api.post).not.toHaveBeenCalled();
});

it('refuses to publish, and sends nothing, when the local record cannot be stored', async () => {
  const h = harness();
  h.store.add = async () => {
    throw new Error('QuotaExceededError');
  };
  const driver = h.make();
  await driver.start('1');
  await expect(driver.create(inputs)).rejects.toThrow(/Nothing was sent/);
  expect(h.api.post).not.toHaveBeenCalled();
});

it('surfaces unreadable storage instead of silently showing no operations', async () => {
  const h = harness();
  h.store.list = async () => {
    throw new Error('blocked');
  };
  const driver = h.make();
  await driver.start('1');
  expect(usePublishState.getState().storageError).toMatch(/blocked/);
});

it('does not spin while a request hangs: no storage re-reads once a send is in flight', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockImplementation(() => new Promise(() => undefined));
  const list = vi.spyOn(h.store, 'list');
  await driver.create(inputs);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(list.mock.calls.length).toBeLessThan(5);
  expect(h.api.post).toHaveBeenCalledTimes(1);
});

it('refuses selections over the Worker caps before storing or sending anything', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const many = Array.from({ length: 3001 }, (_, i) => ({
    hash: i,
    digest: digest(1),
    previous: undefined,
  }));
  await expect(driver.create(many)).rejects.toThrow(/limit is 3000.*Nothing was sent/);
  expect(h.store.records.size).toBe(0);
  expect(h.api.post).not.toHaveBeenCalled();
  // At the cap exactly it is accepted.
  await driver.create(many.slice(0, 3000));
  expect(h.store.records.size).toBe(60);
});

it('only blames the clock for the creation-window rejection; 413 and 403 say what happened', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.status.mockResolvedValue('unknown');
  h.api.post.mockRejectedValueOnce(new PublishHttpError(400, 'Invalid publish body'));
  await driver.create([{ hash: 1, digest: digest(1), previous: undefined }]);
  await settle();
  expect(ops()[0]!.error).not.toMatch(/clock/);
  h.api.post.mockRejectedValueOnce(new PublishHttpError(413, 'too big'));
  await driver.create([{ hash: 2, digest: digest(2), previous: undefined }]);
  await settle();
  expect(ops()[1]!.error).toMatch(/too large/);
  h.api.post.mockRejectedValueOnce(new PublishHttpError(403, 'Forbidden'));
  await driver.create([{ hash: 3, digest: digest(3), previous: undefined }]);
  await settle();
  expect(ops()[2]!.error).toMatch(/may still run; check live status/);
});

it('never kicks an operation a pass just found finished', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  await driver.create(inputs);
  await settle();
  h.api.status.mockResolvedValue('done');
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs + 20_000);
  expect(op().status).toBe('done');
  expect(h.api.kick).not.toHaveBeenCalled();
});

it('rebuilds acknowledgments after a reload only from operations finished in the last 15 minutes', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  h.api.status.mockResolvedValue('done');
  await first.create(inputs);
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(h.acked).toHaveLength(1);
  first.stop();
  vi.setSystemTime(Date.now() + publishTiming.ackWindowMs + 60_000);
  const second = h.make();
  await second.start('1');
  expect(h.acked).toHaveLength(1); // not re-applied: the bundle has long since caught up
  expect(ops()).toHaveLength(1); // but the finished line is still listed
});

it('stops polling a pending operation after 24 hours and says so', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  vi.setSystemTime(Date.now() + publishTiming.pollGiveUpMs + 1000);
  await driver.refresh();
  const polls = h.api.status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(h.api.status.mock.calls.length).toBe(polls);
  expect(usePublishState.getState().notes[created.opId]).toMatch(/Still waiting after 24 hours/);
});

it('persists every chunk before sending and reuses each identity after a lost response and reload', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  h.api.post.mockRejectedValue(new Error('Lost response'));
  await first.create(
    Array.from({ length: 101 }, (_, hash) => ({ hash, digest: digest(1), previous: undefined })),
  );
  await settle();
  const saved = [...h.store.records.values()];
  expect(saved.map((entry) => entry.hashes.length)).toEqual([50, 50, 1]);
  expect(new Set(saved.map((entry) => entry.groupId)).size).toBe(1);
  expect(h.api.post).toHaveBeenCalledTimes(3);
  first.stop();
  const second = h.make();
  h.api.post.mockRejectedValue(new Error('Still offline'));
  await second.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 100);
  for (const entry of saved) {
    expect(h.api.post).toHaveBeenCalledWith({
      opId: entry.opId,
      hashes: entry.hashes,
      expected: entry.expected,
    });
  }
  expect([...h.store.records.keys()]).toEqual(saved.map((entry) => entry.opId));
});
