import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  translationPublishBodySchema,
  translationPublishContract,
  type TranslationPublishRow,
} from '@clarity/core';
import { translationContract } from '../../services/apiAuth';
import { bundleSchema } from '../../services/bundleSchema';
import { PublishHttpError, type PublishAnswer } from '../../services/publisher/api';
import { createMemoryOpStore, type PublishOp } from '../../services/publisher/opStore';
import { independentLanes, type LaneEntry } from './lanes';
import {
  activeTranslations,
  PublishDriver,
  publishTiming,
  usePublishState,
  type PublishApi,
} from './publishDriver';
import { describeOp, groupPublishes } from './publishStatus';

const digest = (letter: string) => letter.repeat(64);
const row = (hash: number, lang: 'de' | 'fr' = 'de'): TranslationPublishRow => ({
  kind: 'tooltip',
  hash,
  lang,
  expected: digest('a'),
  english: digest('b'),
  before: digest('c'),
  effects: digest('d'),
});
const items = (...hashes: number[]) =>
  hashes.map((hash) => ({ row: row(hash), name: `Tooltip ${hash}` }));

function tab(store = createMemoryOpStore()) {
  const api = {
    post: vi.fn<PublishApi['post']>(async () => ({ status: 'pending' })),
    postTranslations: vi.fn<PublishApi['postTranslations']>(async () => ({ status: 'pending' })),
    status: vi.fn<PublishApi['status']>(async () => 'pending'),
    kick: vi.fn<PublishApi['kick']>(async () => undefined),
  };
  const acked: string[] = [];
  const driver = new PublishDriver({
    store,
    api,
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    visible: () => true,
    broadcast: () => undefined,
    acknowledge: (op) =>
      acked.push(...op.translations!.map(({ row }) => `${'hash' in row && row.hash}`)),
  });
  return { store, api, driver, acked };
}
const ops = () => usePublishState.getState().ops;
const sent = (api: ReturnType<typeof tab>['api']) =>
  api.postTranslations.mock.calls.map(([body]) =>
    body.rows.map((entry) => entry.kind === 'tooltip' && entry.hash),
  );
const refuse = (...hashes: number[]): PublishAnswer => ({
  status: 'rejected',
  rows: hashes.map((hash) => ({ key: `${hash}:de`, error: 'Review it again.' })),
});
const view = (list: PublishOp[]) => {
  const { op, checking, liveCount } = groupPublishes(list)[0]!;
  return describeOp(op, undefined, Date.now(), () => 'now', checking, liveCount);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

it('names the same contract as core', () => {
  expect(translationContract).toBe(translationPublishContract);
});

it('sends automatic parts of the size the Worker takes, as one publish', async () => {
  const { driver, api, acked } = tab();
  await driver.start('1', true);
  await driver.createTranslations(items(11, 12, 13, 14, 15), 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(sent(api)).toEqual([[11, 12], [13, 14], [15]]);
  for (const [body] of api.postTranslations.mock.calls)
    expect(translationPublishBodySchema.safeParse(body).success).toBe(true);
  expect(groupPublishes(ops())).toHaveLength(1);
  expect(view(ops()).lead).toBe('0 of 5 translations live.');
  api.status.mockResolvedValue('done');
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0));
  expect(api.status).toHaveBeenCalledWith(expect.any(String), true);
  expect(acked.sort()).toEqual(['11', '12', '13', '14', '15']);
  expect(view(ops())).toMatchObject({ chip: 'Published', lead: '5 German translations' });
});

it('sends the rest of a refused part again without its refused rows, until it lands', async () => {
  const { driver, api, acked } = tab();
  api.postTranslations
    .mockResolvedValueOnce(refuse(2))
    .mockRejectedValueOnce(
      new PublishHttpError(409, 'Review it again.', true, undefined, refuse(3).rows),
    )
    .mockResolvedValue({ status: 'done' });
  await driver.start('1', true);
  await driver.createTranslations(items(1, 2, 3), 12);
  await vi.advanceTimersByTimeAsync(0);
  // The rows that go out again stay held meanwhile, and nothing reads as finished.
  expect([...activeTranslations(ops())]).toEqual(['1:de', '3:de']);
  expect(view(ops())).toMatchObject({ chip: 'Checking…', finished: false });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sent(api)).toEqual([[1, 2, 3], [1, 3], [1]]);
  expect(acked).toEqual(['1']);
  expect(activeTranslations(ops()).size).toBe(0);
  expect(view(ops())).toMatchObject({
    chip: 'Partly live',
    lead: expect.stringContaining('3 German translations'),
    detail: 'Not published: Tooltip 2 (Review it again); Tooltip 3 (Review it again).',
  });
});

it('reads a polled refusal from its receipt, and says so when nothing went live', async () => {
  const { driver, api } = tab();
  await driver.start('1', true);
  await driver.createTranslations(items(1), 12);
  await vi.advanceTimersByTimeAsync(0);
  api.status.mockResolvedValue('rejected');
  api.postTranslations.mockResolvedValue(refuse(1));
  await vi.advanceTimersByTimeAsync(publishTiming.pollMs(0));
  expect(view(ops())).toMatchObject({
    chip: 'Refused',
    detail: 'Not published: Tooltip 1 (Review it again).',
    finished: true,
  });
  expect(sent(api)).toEqual([[1], [1]]);
});

it('two tabs and a reload send the rest once', async () => {
  const first = tab();
  first.api.postTranslations.mockResolvedValueOnce(refuse(2));
  await first.driver.start('1', true);
  await first.driver.createTranslations(items(1, 2), 12);
  await vi.advanceTimersByTimeAsync(0);
  first.driver.stop();
  const second = tab(first.store);
  const third = tab(first.store);
  await Promise.all([second.driver.start('1', true), third.driver.start('1', true)]);
  await vi.advanceTimersByTimeAsync(1_000);
  const resends = [...first.store.records.values()].filter(({ resends }) => resends);
  expect(resends).toHaveLength(1);
  const bodies = [...sent(second.api), ...sent(third.api)];
  expect(bodies.every((hashes) => hashes.join() === '1')).toBe(true);
});

it('keeps a language the account lost out of every later request', async () => {
  const { driver, api } = tab();
  api.postTranslations.mockRejectedValue(
    new PublishHttpError(403, 'Publish only translations in your assigned languages', true),
  );
  await driver.start('1', true);
  await driver.createTranslations(items(1, 2, 3), 2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.postTranslations).toHaveBeenCalledTimes(1);
  expect(view(ops())).toMatchObject({
    tone: 'bad',
    detail: expect.stringContaining('not yours to publish'),
  });
});

it('refuses rows that another publish of this account already holds', async () => {
  const { driver } = tab();
  await driver.start('1', true);
  await driver.createTranslations(items(1), 12);
  await expect(driver.createTranslations(items(1, 2), 12)).rejects.toThrow(
    'already being published',
  );
});

it('a translator’s tab never resumes a whole publish of the same account', async () => {
  const { driver, store, api } = tab();
  await driver.start('1');
  await driver.create([{ hash: 10, digest: digest('a'), previous: undefined }]);
  const before = api.post.mock.calls.length;
  await driver.start('1', true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(ops()).toEqual([]);
  expect(api.post).toHaveBeenCalledTimes(before);
  expect(api.kick).not.toHaveBeenCalled();
  expect(store.records.size).toBe(1);
});

it('an editor’s tab never resumes translations of the same account', async () => {
  const { driver, api } = tab();
  await driver.start('1', true);
  await driver.createTranslations(items(1), 12);
  await vi.advanceTimersByTimeAsync(0);
  const before = api.postTranslations.mock.calls.length;
  await driver.start('1');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(ops()).toEqual([]);
  expect(api.postTranslations).toHaveBeenCalledTimes(before);
  expect(api.status).not.toHaveBeenCalled();
});

it('publishes rows of one language that change the same tooltip one after the other', () => {
  const lane = (hash: number, lang: 'de' | 'fr', affectedHashes: number[]) =>
    ({
      name: `${hash}:${lang}`,
      lane: { hash, lang, row: { status: 'ready', affectedHashes } },
    }) as unknown as LaneEntry;
  const reader = lane(10, 'de', []);
  const source = lane(20, 'de', [10, 30]);
  const other = lane(30, 'fr', []);
  const { sending, held } = independentLanes([reader, source, other]);
  expect(sending).toEqual([reader, other]);
  expect(held.get(source)).toBe(reader);
});

it('reads only a bundle of this contract, and never mixes up languages', () => {
  const ready = {
    ...row(10),
    status: 'ready',
    removed: false,
    englishFallback: false,
    affectedHashes: [],
  };
  const parse = (translationPublish: unknown) =>
    bundleSchema.parse({
      sourceCommit: 'a',
      generatedAt: '2026-01-01T00:00:00Z',
      tooltips: {},
      pushed: {},
      permissions: { users: {} },
      translationPublish,
    }).translationPublish;
  const value = {
    version: translationPublishContract,
    liveCommit: 'a',
    lanes: { de: [ready] },
    only: { tooltips: [10], globals: [] },
  };
  expect(parse(value)?.lanes.de).toHaveLength(1);
  expect(parse({ ...value, only: 'broken' })).toMatchObject({ only: undefined });
  expect(parse({ ...value, version: 'translation-publish-v2' })).toBeUndefined();
  expect(parse({ ...value, lanes: { fr: [ready] } })).toBeUndefined();
  expect(parse({ ...value, lanes: { en: [{ ...ready, lang: 'en' }] } })).toBeUndefined();
  expect(parse({ ...value, lanes: { de: [{ ...ready, before: 'x' }] } })).toBeUndefined();
});
