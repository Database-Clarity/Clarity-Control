import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { clearSavedOverlay } from '../../stores/savedOverlay';
import type { Change } from '../api';
import { saveChunks } from './chunks';
import { saveCurrent, saveRemainder } from './currentSave';
import { editorData, english } from './fixtures.testSupport';
import { fitsSaveRequest, saveRequestLimits } from './requestSize';
import { reviewSaveChanges, useSaveState } from './state';

const post = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ apiUrl: '', save: post }));
vi.mock('./validationWorker', async () => {
  const { saveChunks } = await import('./chunks');
  return { requestSaveChunks: saveChunks };
});

const makeTooltip = (hash: number, text = 'Description'): Tooltip => ({
  hash,
  associated: [],
  text: { en: { ...english, text } },
});
const real = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL('../../../../../packages/core/src/numbers/fixtures/english.json.gz', import.meta.url),
    ),
  ).toString('utf8'),
).english as { hash: number; text: string }[];
const catalogue = Object.fromEntries(real.map(({ hash, text }) => [hash, makeTooltip(hash, text)]));
const target = real.find(({ hash }) => hash > 3)!.hash;
const realChanges = (count: number): Change[] =>
  Object.values(catalogue)
    .filter(({ hash }) => hash > 3 && hash !== target)
    .slice(0, count)
    .map((base) => ({ hash: base.hash, base, next: { ...base, associated: [target] } }));
const loaded = () => ({
  ...editorData(),
  aliases: {},
  bundle: { ...editorData().bundle, tooltips: catalogue },
});

afterEach(() => {
  useSaveState.getState().close();
  clearSavedOverlay();
  post.mockReset();
  vi.unstubAllGlobals();
});

it.each([415, 1000])(
  'saves %i real tooltip records through sequential bounded requests',
  async (count) => {
    const changes = realChanges(count);
    expect(changes).toHaveLength(count);
    const data = loaded();
    useDataStore.setState({ data });
    const submitted = Object.fromEntries(
      changes.map(({ hash, base, next }) => [hash, { base: base!, next }]),
    );
    const flush = vi.fn(async () => {});
    useDraftStore.setState({
      drafts: submitted,
      external: false,
      error: null,
      retry: () => {},
      flush,
    });
    reviewSaveChanges(changes, submitted);
    const review = useSaveState.getState().review!;
    post.mockImplementation(async (chunk: Change[], message: string) => {
      expect(fitsSaveRequest(chunk, message, false)).toBe(true);
      expect(flush).toHaveBeenCalledTimes(post.mock.calls.length - 1);
      return {
        kind: 'saved',
        tooltips: chunk.map(({ next }) => next),
        commit: String(post.mock.calls.length),
      };
    });
    const result = await saveCurrent({
      prepared: changes,
      data,
      review,
      message: 'Review Compendium links',
      noTranslationImpact: false,
      sameSession: () => true,
      accountChanged: () => false,
    });
    expect(result.kind).toBe('saved');
    expect(result.accepted.size).toBe(count);
    expect(useSaveState.getState().progress).toMatchObject({ done: count, total: count });
    expect(useDraftStore.getState().drafts).toEqual({});
  },
);

it('keeps a real resolver import target with or before its importer', () => {
  const base = makeTooltip(100_001);
  const importer = { ...base, text: { en: { ...english, text: 'import main from 900000' } } };
  const donor = makeTooltip(900_000, 'Imported real text.');
  const changes = [
    { hash: base.hash, base, next: importer },
    ...Array.from({ length: saveRequestLimits.changes }, (_, index) => {
      const next = makeTooltip(200_000 + index);
      return { hash: next.hash, base: null, next };
    }),
    { hash: donor.hash, base: null, next: donor },
  ];
  const chunks = saveChunks(changes, loaded(), 'Save imports', false);
  const chunkOf = (hash: number) =>
    chunks.findIndex((chunk) => chunk.some((item) => item.hash === hash));
  expect(chunkOf(donor.hash)).toBeLessThanOrEqual(chunkOf(base.hash));
  expect(chunks.flat()).toHaveLength(changes.length);
});

it('stops after a failed later request and resumes with only the unsaved drafts', async () => {
  const changes = realChanges(saveRequestLimits.changes * 2 + 1);
  const data = loaded();
  useDataStore.setState({ data });
  const submitted = Object.fromEntries(
    changes.map(({ hash, base, next }) => [hash, { base: base!, next }]),
  );
  useDraftStore.setState({
    drafts: submitted,
    external: false,
    error: null,
    retry: () => {},
    flush: async () => {},
  });
  reviewSaveChanges(changes, submitted);
  const review = useSaveState.getState().review!;
  const send = async (chunk: Change[]) => ({
    kind: 'saved',
    tooltips: chunk.map(({ next }) => next),
    commit: String(post.mock.calls.length),
  });
  post
    .mockImplementationOnce(send)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockImplementation(send);
  const options = {
    message: 'Save',
    noTranslationImpact: false,
    sameSession: () => true,
    accountChanged: () => false,
  };
  const first = await saveCurrent({ ...options, prepared: changes, review, data });
  expect(first.kind).toBe('failed');
  expect(post).toHaveBeenCalledTimes(2);
  expect(first.accepted.size).toBe(saveRequestLimits.changes);
  const remaining = saveRemainder(review, first.accepted);
  expect(useDraftStore.getState().drafts).toEqual(remaining.submitted);
  useSaveState.setState({ review: remaining });
  const next = await saveCurrent({
    ...options,
    prepared: remaining.changes,
    review: remaining,
    data: useDataStore.getState().data!,
  });
  expect(next.kind).toBe('saved');
  const sentAfterFailure = post.mock.calls.slice(2).flatMap(([chunk]) => chunk as Change[]);
  expect(sentAfterFailure.every(({ hash }) => !first.accepted.has(hash))).toBe(true);
  expect(useSaveState.getState().progress).toMatchObject({
    done: changes.length,
    total: changes.length,
  });
  expect(useDraftStore.getState().drafts).toEqual({});
});
