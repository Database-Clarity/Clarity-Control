import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PublishHttpError, type RemoteStatus } from '../../services/publisher/api';
import { createMemoryOpStore, type OpStore } from '../../services/publisher/opStore';
import { describeOp, groupPublishes } from './publishStatus';
import {
  activeGlobals,
  activeHashes,
  PublishDriver,
  publishingAlready,
  publishChunks,
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
    postTranslations: ReturnType<typeof vi.fn<PublishApi['postTranslations']>>;
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
    postTranslations: vi.fn<PublishApi['postTranslations']>(async () => ({ status: 'pending' })),
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
        list: (userId) => store.list(userId),
        addMany: async (ops, busy) => {
          log.push('store.add');
          return store.addMany(ops, busy);
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

it('retries up to 500 proofs and stops with the refused hashes and reason once no progress is possible', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const reviewed = Array.from({ length: 550 }, (_, hash) => ({
    hash: hash + 1000,
    digest: digest(1),
    previous: undefined,
  }));
  const reason = 'Missing named export';
  let resolved = false;
  h.api.status.mockImplementation(async () => (resolved ? 'rejected' : 'pending'));
  h.api.post.mockImplementation(async (body) =>
    resolved && ops().some((op) => op.opId === body.opId && op.acceptedAt !== undefined)
      ? { status: 'rejected', refusal: reason }
      : { status: 'pending' },
  );
  const first = await driver.create(reviewed);
  await settle();
  expect(h.api.post).toHaveBeenCalledTimes(11);
  resolved = true;
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(ops().map(({ round, consumers }) => [round, consumers])).toEqual([
    [1, 500],
    [1, 50],
  ]);
  expect(ops().every(({ groupId }) => groupId === first.groupId)).toBe(true);
  expect(groupPublishes(ops())[0]?.op.status).toBe('pending');
  expect(h.api.post).toHaveBeenCalledTimes(24); // 11 sends, 11 receipt reads, and 2 new sends.
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  const failed = groupPublishes(ops())[0]?.op;
  expect(failed?.status).toBe('failed');
  expect(failed?.error).toContain(`1009 and 490 more: ${reason}`);
  expect(failed?.error).toContain(`1509 and 40 more: ${reason}`);
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(h.api.post).toHaveBeenCalledTimes(26);
  driver.stop();
});

it.each([false, true])(
  'resumes after reload and preserves successful parts (older tab rejected: %s)',
  async (oldTab) => {
    const h = harness();
    const first = h.make();
    await first.start('1');
    const reviewed = Array.from({ length: 101 }, (_, hash) => ({
      hash: hash + 1000,
      digest: digest(1),
      previous: undefined,
    }));
    const globals = [{ id: 'g_refill-0001', expected: digest(3), name: 'G_refill' }];
    const group = await first.create(reviewed, globals);
    await settle();
    const admitted = h.api.post.mock.calls.map(([body]) => body);
    expect(admitted.map(({ hashes }) => hashes.length)).toEqual([50, 50, 1]);
    // Globals go with the first part, by id and digest only.
    expect(admitted.map((sent) => sent.globals)).toEqual([
      [{ id: 'g_refill-0001', expected: digest(3) }],
      undefined,
      undefined,
    ]);
    first.stop();
    const resumed = h.make();
    const refused = admitted.slice(1);
    if (oldTab)
      for (const { opId } of refused)
        await h.store.update(opId, (op) => ({ ...op, status: 'rejected' }));
    h.api.status.mockImplementation(async (id) =>
      refused.some(({ opId }) => opId === id) ? 'rejected' : 'done',
    );
    h.api.post.mockImplementation(async (body) =>
      refused.some(({ opId }) => opId === body.opId)
        ? { status: 'rejected', refusal: 'Missing import' }
        : body.globals
          ? { status: 'done', globals: { live: ['g_refill-0001'], refused: [] } }
          : { status: 'pending' },
    );
    vi.setSystemTime(Date.now() + 10_000);
    await resumed.start('1');
    // The first part's globals are read from its receipt; that is not a retry.
    const retried = h.api.post.mock.calls
      .slice(3)
      .map(([body]) => body)
      .filter(({ opId }) => opId !== admitted[0]!.opId);
    expect(retried.slice(0, 2)).toEqual(refused);
    expect(retried[2]?.hashes).toEqual(refused.flatMap(({ hashes }) => hashes));
    expect(retried[2]?.expected).toEqual(
      Object.assign({}, ...refused.map(({ expected }) => expected)),
    );
    expect(ops().map(({ groupId, status }) => [groupId, status])).toEqual([
      [group.groupId, 'done'],
      [group.groupId, 'pending'],
    ]);
    await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
    expect(groupPublishes(ops())[0]?.op.status).toBe('done');
    resumed.stop();
  },
);

it('publishes globals alone, keeps them across a reload and a refusal, and holds them meanwhile', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  const globals = [{ id: 'g_refill-0001', expected: digest(3), name: 'G_refill' }];
  await first.create([], globals);
  await settle();
  const sent = h.api.post.mock.calls[0]![0];
  expect(sent).toEqual({
    opId: op().opId,
    hashes: [],
    expected: {},
    globals: [{ id: 'g_refill-0001', expected: digest(3) }],
  });
  expect(activeGlobals(ops())).toEqual(new Set(['g_refill-0001']));
  await expect(first.create([inputs[0]!], globals)).rejects.toThrow(publishingAlready);
  first.stop();
  const resumed = h.make();
  h.api.status.mockResolvedValue('unknown');
  vi.setSystemTime(Date.now() + 10_000);
  await resumed.start('1');
  expect(h.api.post.mock.calls.at(-1)![0]).toEqual(sent);
  expect(describeOp(op(), undefined, Date.now(), () => 'now').lead).toBe('G_refill');
  h.api.status.mockResolvedValue('rejected');
  h.api.post.mockResolvedValue({ status: 'rejected', refusal: 'Tooltip 10: no.' });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) * 3);
  expect(op()).toMatchObject({ status: 'rejected', error: 'G_refill: Tooltip 10: no.' });
  resumed.stop();
});

it('reads which globals a finished request left out, and says so', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const globals = ['a', 'b'].map((name) => ({ id: `g_${name}0000000`, expected: digest(3), name }));
  await driver.create([inputs[0]!], globals);
  await settle();
  h.api.status.mockResolvedValue('done');
  h.api.post.mockRejectedValueOnce(new PublishHttpError(503, 'busy'));
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  // Not known yet: nothing is called live, and it asks again.
  expect(op().status).toBe('pending');
  expect(h.acked).toEqual([]);
  h.api.post.mockResolvedValue({
    status: 'done',
    globals: { live: ['g_a0000000'], refused: [{ id: 'g_b0000000', error: 'Tooltip 10: no.' }] },
  });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) * 3);
  await vi.advanceTimersByTimeAsync(0);
  expect(op()).toMatchObject({
    status: 'done',
    refusedGlobals: [{ id: 'g_b0000000', name: 'b', error: 'Tooltip 10: no.' }],
  });
  const view = describeOp(op(), undefined, Date.now(), () => 'now');
  expect(view).toMatchObject({
    chip: 'Partly live',
    detail: 'Not published: b (Tooltip 10: no).',
    finished: true,
  });
  driver.stop();
});

it.each([
  ['a lone global without a readable receipt', [], undefined],
  ['a refused receipt read', [inputs[0]!], 409],
  ['an outcome that skips a global', [inputs[0]!], 'other'],
] as const)('calls nothing live after %s', async (_name, tooltips, answer) => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  await driver.create([...tooltips], [{ id: 'g_a0000000', expected: digest(3), name: 'a' }]);
  await settle();
  h.api.status.mockResolvedValue('done');
  if (answer === 409) h.api.post.mockRejectedValue(new PublishHttpError(409, 'conflict', true));
  else
    h.api.post.mockResolvedValue({
      status: 'done',
      ...(answer ? { globals: { live: [answer], refused: [] } } : {}),
    });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(op()).toMatchObject({ status: 'failed' });
  expect(op().error).toContain('could not be read');
  expect(h.acked).toEqual([]);
  driver.stop();
});

it('counts and names only what is live when a later part of a group fails', () => {
  const part = (index: number, values: object) =>
    ({
      opId: `p${index}`,
      groupId: 'p0',
      groupSize: 2,
      groupIndex: index,
      groupHashCount: 2,
      consumers: 1,
      userId: '1',
      createdAt: 0,
      hashes: [10 + index],
      expected: {},
      previous: {},
      status: 'done',
      updatedAt: 0,
      ...values,
    }) as ReturnType<typeof ops>[number];
  const [group] = groupPublishes([
    part(0, {
      globals: [
        { id: 'a', expected: '', name: 'a' },
        { id: 'b', expected: '', name: 'b' },
      ],
      refusedGlobals: [{ id: 'b', name: 'b', error: 'Tooltip 10: no.' }],
    }),
    part(1, { status: 'failed', error: 'The run failed.' }),
  ]);
  expect(group!.op.error).toContain('2 of 4 changes confirmed live');
  expect(group!.op.error).toContain('Not published: b (Tooltip 10: no).');
});

it('shows a named changed row without resending its part after another part succeeds', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  await driver.create(
    Array.from({ length: 101 }, (_, index) => ({
      hash: index + 1000,
      digest: digest(1),
      previous: undefined,
    })),
  );
  await settle();
  const done = h.api.post.mock.calls[0]![0];
  const failed = h.api.post.mock.calls[1]![0];
  const changed = h.api.post.mock.calls[2]![0];
  const reason = 'Saved text changed after review for Demo Perk.';
  h.api.status.mockImplementation(async (id) =>
    id === done.opId ? 'done' : id === failed.opId ? 'failed' : 'rejected',
  );
  h.api.post.mockResolvedValue({ status: 'rejected', refusal: reason, regroupable: false });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(h.api.post.mock.calls.map(([body]) => body)).toEqual([done, failed, changed, changed]);
  expect(groupPublishes(ops())[0]?.op.error).toContain(reason);
  expect(ops().find((op) => op.opId === changed.opId)?.receiptChecked).toBe(true);
  expect(ops().find((op) => op.opId === done.opId)?.status).toBe('done');
  driver.stop();
});

it('records that a rejection without a regroupable reason was checked', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  const created = await first.create(inputs);
  await settle();
  first.stop();
  await h.store.update(created.opId, (op) => ({ ...op, status: 'rejected' }));

  const resumed = h.make();
  h.api.post.mockResolvedValue({ status: 'rejected' });
  vi.setSystemTime(Date.now() + 10_000);
  await resumed.start('1');
  expect(op()).toMatchObject({ status: 'rejected', receiptChecked: true });
  expect(h.api.post.mock.calls[1]).toEqual(h.api.post.mock.calls[0]);
  await vi.advanceTimersByTimeAsync(2 * publishTiming.pollMs(0));
  expect(h.api.post).toHaveBeenCalledTimes(2);
  resumed.stop();
});

it('reads the named refusal for a pending request stored before round metadata', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  const created = await first.create(inputs);
  await settle();
  first.stop();
  const stored = h.store.records.get(created.opId)!;
  delete stored.round;
  const resumed = h.make();
  const reason = 'Saved text changed after review for Demo Perk.';
  h.api.status.mockResolvedValue('rejected');
  h.api.post.mockResolvedValue({ status: 'rejected', refusal: reason, regroupable: false });
  vi.setSystemTime(Date.now() + 10_000);
  await resumed.start('1');
  expect(op()).toMatchObject({ status: 'rejected', error: reason, receiptChecked: true });
  resumed.stop();
});

it('holds the whole group while any older-tab receipt is unread, then shows no dead Retry', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  const reviewed = Array.from({ length: 51 }, (_, hash) => ({
    hash: hash + 100,
    digest: digest(1),
    previous: undefined,
  }));
  await first.create(reviewed);
  await settle();
  const admitted = h.api.post.mock.calls.map(([body]) => body);
  expect(admitted.map(({ hashes }) => hashes.length)).toEqual([50, 1]);
  first.stop();
  for (const { opId } of admitted)
    await h.store.update(opId, (op) => ({ ...op, status: 'rejected' }));

  const resumed = h.make();
  // The first receipt reads; the second keeps failing for now.
  let unavailable = true;
  h.api.post.mockImplementation(async (body) => {
    if (body.opId === admitted[1]!.opId && unavailable) throw new PublishHttpError(0, 'offline');
    return admitted.some(({ opId }) => opId === body.opId)
      ? { status: 'rejected', refusal: 'Missing export' }
      : { status: 'pending' };
  });
  vi.setSystemTime(Date.now() + 10_000);
  await resumed.start('1');
  expect(ops().map(({ refusal }) => refusal)).toEqual(['Missing export', undefined]);
  expect(activeHashes(ops())).toEqual(new Set(reviewed.map(({ hash }) => hash)));

  // Aged: every part is terminal, so nothing is queued and Retry would do nothing.
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  const group = groupPublishes(ops())[0]!;
  const view = describeOp(group.op, undefined, Date.now(), String, group.checking);
  expect(view).toMatchObject({ chip: 'Checking…', waiting: false, finished: false });
  expect(activeHashes(ops()).size).toBe(51);
  expect(h.api.kick).not.toHaveBeenCalled();

  // Once the last receipt reads, exactly one combined request carries all 51 rows.
  unavailable = false;
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(Infinity) + 100);
  const sent = h.api.post.mock.calls
    .map(([body]) => body)
    .filter(({ opId }) => !admitted.some((original) => original.opId === opId));
  expect(sent.map(({ hashes }) => hashes.length)).toEqual([51]);
  expect(activeHashes(ops()).size).toBe(51);
  resumed.stop();
});

it('backs off receipt reads, and stops while signed out until the account signs in again', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  const created = await first.create(inputs);
  await settle();
  first.stop();
  await h.store.update(created.opId, (op) => ({ ...op, status: 'rejected' }));
  const reads = () => h.api.post.mock.calls.length - 1;

  const resumed = h.make();
  h.api.post.mockRejectedValue(new PublishHttpError(503, 'unavailable'));
  await resumed.start('1');
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  // Status-poll pacing (4 s, then 10 s, 30 s, and 60 s), not a read every 4 s (150).
  expect(reads()).toBeGreaterThan(10);
  expect(reads()).toBeLessThanOrEqual(40);

  h.api.post.mockRejectedValue(new PublishHttpError(401, 'expired'));
  await vi.advanceTimersByTimeAsync(60_000);
  const signedOut = reads();
  expect(usePublishState.getState().notes[created.opId]).toMatch(/Sign in again/);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(reads()).toBe(signedOut);

  h.api.post.mockResolvedValue({ status: 'rejected' });
  await resumed.start('1');
  expect(reads()).toBe(signedOut + 1);
  expect(op()).toMatchObject({ status: 'rejected', receiptChecked: true });
  resumed.stop();
});

it('stores nothing for rows another publish already holds (a confirmation that outlived its list)', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  const created = await first.create(inputs);
  await settle();
  first.stop();
  // An older tab left this part refused with its receipt unread: the group still holds its rows.
  await h.store.update(created.opId, (op) => ({ ...op, status: 'rejected' }));
  const driver = h.make();
  h.api.post.mockRejectedValue(new PublishHttpError(0, 'offline'));
  await driver.start('1');
  const posts = h.api.post.mock.calls.length;
  await expect(driver.create([inputs[0]!])).rejects.toThrow(publishingAlready);
  expect(await h.store.list('1')).toHaveLength(1);
  expect(h.api.post.mock.calls.slice(posts).every(([body]) => body.opId === created.opId)).toBe(
    true,
  );
  driver.stop();
});

it('stores a rejection seen by status polling as an unread receipt: no Retry, no kick', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  await driver.create(inputs);
  await settle();
  h.api.status.mockResolvedValue('rejected');
  h.api.post.mockRejectedValue(new PublishHttpError(503, 'busy'));
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(op()).toMatchObject({ status: 'rejected' });
  expect(op().receiptChecked).toBeUndefined();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  const group = groupPublishes(ops())[0]!;
  const view = describeOp(group.op, undefined, Date.now(), String, group.checking);
  expect(view).toMatchObject({ chip: 'Checking…', waiting: false });
  await driver.kickWaiting(op().opId);
  expect(h.api.kick).not.toHaveBeenCalled();
  // Reads back off like any receipt (first POST is the original send).
  expect(h.api.post.mock.calls.length - 1).toBeLessThanOrEqual(40);

  // A 401 pauses the reads; a definite 403 after signing in finishes the part with what is known.
  h.api.post.mockRejectedValue(new PublishHttpError(401, 'expired'));
  await vi.advanceTimersByTimeAsync(60_000);
  const paused = h.api.post.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(h.api.post.mock.calls.length).toBe(paused);
  h.api.post.mockRejectedValue(new PublishHttpError(403, 'Access revoked', true));
  await driver.start('1');
  expect(op()).toMatchObject({ status: 'rejected', receiptChecked: true });
  expect(op().error).toContain('Its reason could not be read (HTTP 403: Access revoked)');
  const finished = h.api.post.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(h.api.post.mock.calls.length).toBe(finished);
  expect(h.api.kick).not.toHaveBeenCalled();
  driver.stop();
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
  if (status === 'rejected')
    h.api.post.mockResolvedValueOnce({ status, refusal: 'Missing export' });
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0) + 100);
  expect(op().status).toBe(status);
  expect(h.acked).toEqual(acknowledged ? [created.opId] : []);
  // Terminal means no more polling or resends after reading a refused operation's receipt.
  const polls = h.api.status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(h.api.status.mock.calls.length).toBe(polls);
  expect(h.api.post).toHaveBeenCalledTimes(status === 'rejected' ? 2 : 1);
  if (status === 'rejected') {
    expect(h.api.post.mock.calls[1]).toEqual(h.api.post.mock.calls[0]);
    expect(op().error).toBe('Tooltips 10, 20: Missing export');
  }
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

it('auto-kicks after five minutes, then waits at least ten more minutes across a reload', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const created = await driver.create(inputs);
  await settle();
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs - 5_000);
  expect(h.api.kick).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(35_000);
  expect(h.api.kick).toHaveBeenCalledTimes(1);
  expect(h.api.kick).toHaveBeenCalledWith(created.opId);
  driver.stop();
  const again = h.make();
  await again.start('1');
  const kickedAt = h.store.records.get(created.opId)!.kickedAt!;
  await vi.advanceTimersByTimeAsync(kickedAt + publishTiming.autoKickGapMs - Date.now() - 1);
  expect(h.api.kick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(h.api.kick).toHaveBeenCalledTimes(2);
});

it('detects a completed part and shares the kick cooldown across four parts and a reload', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  await first.create(
    Array.from({ length: 151 }, (_, hash) => ({ hash, digest: digest(1), previous: undefined })),
  );
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs + 30_000);
  const [head, middle] = ops();
  expect(h.api.post).toHaveBeenCalledTimes(4);
  expect(h.api.kick.mock.calls).toEqual([[head!.opId]]);
  first.stop();

  const reloaded = h.make();
  const finished = new Set([head!.opId]);
  h.api.status.mockImplementation(async (id) => (finished.has(id) ? 'done' : 'pending'));
  await reloaded.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickGapMs - 60_000);
  expect(ops()[0]?.status).toBe('done');
  expect(h.api.kick.mock.calls).toEqual([[head!.opId]]);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(h.api.kick.mock.calls).toEqual([[head!.opId], [middle!.opId]]);
});

it('waits five minutes after a new bundle or a part finishes, and requires a successful status check', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const head = await driver.create(
    Array.from({ length: 51 }, (_, hash) => ({ hash, digest: digest(1), previous: undefined })),
  );
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs - 90_000);
  await h.store.observeBundle(Date.now(), Date.now());
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.api.kick).not.toHaveBeenCalled();
  h.api.status.mockImplementation(async (id) => (id === head.opId ? 'done' : 'pending'));
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs - 30_000);
  expect(ops()[0]?.status).toBe('done');
  expect(h.api.kick).not.toHaveBeenCalled();
  h.api.status.mockRejectedValue(new PublishHttpError(0, 'Offline'));
  await vi.advanceTimersByTimeAsync(90_000);
  expect(h.api.kick).not.toHaveBeenCalled();
  h.api.status.mockResolvedValue('pending');
  await vi.advanceTimersByTimeAsync(31_000);
  expect(h.api.kick.mock.calls).toEqual([[ops()[1]!.opId]]);
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

it('shares observed bundle progress with a stale tab after the observing tab closes', async () => {
  const h = harness();
  const tabA = h.make();
  await tabA.start('1');
  const created = await tabA.create(inputs);
  await settle();
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  await h.store.observeBundle(Date.now() - 30_000, Date.now());
  tabA.stop();

  const tabB = h.make();
  await h.store.observeBundle(created.createdAt, Date.now());
  await tabB.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.autoKickMs - 1);
  expect(h.api.kick).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(h.api.kick.mock.calls).toEqual([[created.opId]]);
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
  h.store.addMany = async () => {
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

it('stores selections over the Worker request size as one group of bounded chunks', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const many = Array.from({ length: 3001 }, (_, i) => ({
    hash: i,
    digest: digest(1),
    previous: undefined,
  }));
  await driver.create(many);
  expect(h.store.records.size).toBe(61);
  expect([...h.store.records.values()].flatMap((op) => op.hashes)).toEqual(
    many.map((row) => row.hash),
  );
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

it("shows the Worker's 409 reason; the old sentence is the fallback without one", async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const reasons: Array<[message: string, fromWorker: boolean]> = [
    ['opId already names another publish intent', true],
    ['Tooltip 20 changed since review; refresh saved changes', true],
    ['Sync pending: complete publication proof required', true],
    ['<html>Bad gateway</html>', false],
  ];
  for (const [i, [message, fromWorker]] of reasons.entries()) {
    h.api.post.mockRejectedValueOnce(new PublishHttpError(409, message, fromWorker));
    await driver.create([{ hash: i + 1, digest: digest(i + 1), previous: undefined }]);
    await settle();
  }
  expect(ops().map((entry) => entry.error)).toEqual([
    'opId already names another publish intent',
    'Tooltip 20 changed since review; refresh saved changes',
    'Sync pending: complete publication proof required',
    'This publish id was already used with different contents. Publish again.',
  ]);
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
  expect(h.api.post).toHaveBeenCalledTimes(1);
  first.stop();
  const second = h.make();
  h.api.post.mockRejectedValue(new Error('Still offline'));
  await second.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 100);
  expect(new Set(h.api.post.mock.calls.map(([body]) => body.opId))).toEqual(
    new Set([saved[0]!.opId]),
  );
  h.api.post.mockResolvedValue({ status: 'pending' });
  await vi.advanceTimersByTimeAsync(70_000);
  for (const entry of saved)
    expect(h.api.post).toHaveBeenCalledWith({
      opId: entry.opId,
      hashes: entry.hashes,
      expected: entry.expected,
    });
  expect([...h.store.records.keys()]).toEqual(saved.map((entry) => entry.opId));
});

it('keeps the Nail, Meet Hammer pending import closure together across the old 50 boundary', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  const many = Array.from({ length: 50 }, (_, i) => ({
    hash: i + 100,
    digest: digest(1),
    previous: undefined,
  }));
  await driver.create([
    ...many,
    { hash: 1209885908, digest: digest(2), previous: undefined, dependencies: [2152442764] },
    { hash: 2152442764, digest: digest(3), previous: undefined },
  ]);
  await settle();
  expect(ops().map((op) => op.hashes)).toEqual([many.map((x) => x.hash), [1209885908, 2152442764]]);
});
it('keeps transitive imports and cycles in one oversize closure, and refuses missing pending selections', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    hash: i,
    digest: digest(1),
    previous: undefined,
    dependencies: [(i + 1) % 60],
  }));
  expect(publishChunks(many).map((chunk) => chunk.length)).toEqual([60]);
  expect(() => publishChunks(many.slice(0, 59))).toThrow(/Select pending imported tooltip 59/);
  expect(() => publishChunks(many.map((row) => ({ ...row, consumers: 9 })))).toThrow(
    /cannot safely split/,
  );
});

it('splits a multilingual selection below the Worker publication proof limit', () => {
  const many = Array.from({ length: 100 }, (_, hash) => ({
    hash,
    previous: undefined,
    consumers: 13,
    dependencies: hash === 0 ? [99] : [],
  }));
  const chunks = publishChunks(many);
  expect(chunks.map((chunk) => chunk.length)).toEqual([38, 38, 24]);
  expect(chunks[0]?.map(({ hash }) => hash).slice(0, 2)).toEqual([0, 99]);
});

it('sends an acyclic prerequisite before a cycle that fills the proof budget', () => {
  const rows = [
    { hash: 1, consumers: 250, dependencies: [2, 3] },
    { hash: 2, consumers: 250, dependencies: [1] },
    { hash: 3, consumers: 1 },
  ].map((row) => ({ ...row, previous: undefined }));
  expect(publishChunks(rows).map((chunk) => chunk.map(({ hash }) => hash))).toEqual([[3], [1, 2]]);
});

it('does not send later group chunks after a definite earlier POST failure, even after dismissal and reload', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  h.api.post.mockRejectedValue(new PublishHttpError(413, 'Too large'));
  await first.create(
    Array.from({ length: 51 }, (_, hash) => ({ hash, digest: digest(1), previous: undefined })),
  );
  await settle();
  const saved = [...h.store.records.values()];
  expect(h.api.post).toHaveBeenCalledTimes(1);
  expect(saved.map((entry) => entry.status)).toEqual(['failed', 'failed']);
  expect(saved[1]!.error).toContain('Further sends of this chunk were stopped');
  await first.dismiss(saved[0]!.opId);
  first.stop();
  const second = h.make();
  await second.start('1');
  await settle();
  expect(h.api.post).toHaveBeenCalledTimes(1);
});

it('uses persisted chunk order rather than random ULID order after reloading an unsent group', async () => {
  const h = harness();
  const first = h.make();
  await first.start('1');
  h.api.post.mockRejectedValue(new Error('offline'));
  await first.create(
    Array.from({ length: 51 }, (_, hash) => ({ hash, digest: digest(1), previous: undefined })),
  );
  await settle();
  first.stop();
  const saved = [...h.store.records.values()];
  h.store.records.clear();
  for (const [index, entry] of saved.entries()) {
    entry.opId = entry.opId.slice(0, 10) + (index === 0 ? 'Z' : '0').repeat(16);
    entry.groupId = 'reload-order';
    h.store.records.set(entry.opId, entry);
  }
  const second = h.make();
  h.api.post.mockRejectedValue(new Error('offline'));
  await second.start('1');
  await vi.advanceTimersByTimeAsync(publishTiming.foreignAttemptMs + 100);
  expect(new Set(h.api.post.mock.calls.map(([body]) => body.hashes[0]))).toEqual(new Set([0]));
});

it('backs off a group acceptance check when browser storage cannot be read', async () => {
  const h = harness();
  const driver = h.make();
  await driver.start('1');
  h.api.post.mockRejectedValue(new Error('offline'));
  await driver.create(
    Array.from({ length: 51 }, (_, hash) => ({ hash, digest: digest(1), previous: undefined })),
  );
  await settle();
  const list = vi.spyOn(h.store, 'list').mockRejectedValue(new Error('storage unavailable'));
  const posts = h.api.post.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.api.post).toHaveBeenCalledTimes(posts);
  expect(list.mock.calls.length).toBeLessThan(20);
});

it('never sends an old account’s operation after switching accounts during the attempt write', async () => {
  const h = harness();
  const update = h.store.update;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.store.update = async (opId, change) => {
    await blocked;
    return update(opId, change);
  };
  const driver = h.make();
  await driver.start('1');
  await driver.create(inputs);
  await driver.start('2');
  release();
  await settle();
  expect(h.api.post).not.toHaveBeenCalled();
});
