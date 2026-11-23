import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { Fixture, makePrivateKey } from '../../../../worker/test/fixture';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { clearSavedOverlay } from '../../stores/savedOverlay';
import * as storage from '../draftStorage';
import * as apiAuth from '../apiAuth';
import type { Change } from '../api';
import { saveChunks } from './chunks';
import { saveCurrent, saveRemainder } from './currentSave';
import { editorData, english } from './fixtures.testSupport';
import { fitsSaveRequest, metadataOnly, saveChangeCost, saveRequestLimits } from './requestSize';
import * as staged from './stagedCurrentSave';
import { reviewSaveChanges, useSaveState } from './state';

const post = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ apiUrl: '', save: post }));
vi.mock('../apiAuth', async (original) => ({
  ...(await original<object>()),
  endpoint: (path: string) => `https://worker.test${path}`,
  authorization: () => ({}),
}));
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([422, 409, 'network'] as const)(
  'keeps the finalization receipt only when refusal %s can be ambiguous',
  async (status) => {
    const request = vi
      .spyOn(apiAuth, 'apiRequest')
      .mockResolvedValueOnce(Response.json({ accepted: 0 }));
    if (status === 'network') request.mockRejectedValueOnce(new TypeError('Connection closed'));
    else request.mockResolvedValueOnce(Response.json({ error: 'Finalize refused' }, { status }));
    const receipt = vi.fn(async () => {});
    await expect(
      staged.stageCurrentSave(
        '01K95H00000000000000000A02',
        realChanges(1),
        'Edit',
        false,
        () => true,
        () => {},
        receipt,
      ),
    ).rejects.toThrow(status === 'network' ? 'Connection closed' : 'Finalize refused');
    expect(receipt).toHaveBeenNthCalledWith(1, {
      parts: 1,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(receipt).toHaveBeenCalledTimes(status === 422 ? 2 : 1);
    if (status === 422) expect(receipt).toHaveBeenLastCalledWith(undefined);
  },
);

it.each([415, 1000])(
  'saves %i real tooltip records through sequential bounded requests',
  async (count) => {
    const changes = realChanges(count);
    expect(changes).toHaveLength(count);
    const worker = new Fixture(await makePrivateKey());
    worker.aliases = {};
    worker.moveData({
      '.publisher/PIN': JSON.parse(
        readFileSync(
          new URL('../../../../../scripts/publisher/template/.publisher/PIN', import.meta.url),
          'utf8',
        ),
      ),
      ...Object.fromEntries(changes.map(({ hash, base }) => [`tooltips/${hash}.json`, base])),
    });
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
      const previousRequests = worker.subrequests;
      const response = await worker.request('/save', 'POST', { changes: chunk, message });
      const saved = await response.json();
      expect(response.status, JSON.stringify(saved)).toBe(200);
      expect(worker.subrequests - previousRequests).toBeLessThanOrEqual(50);
      return { kind: 'saved', ...saved };
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
    expect(result.kind, result.kind === 'failed' ? result.error : undefined).toBe('saved');
    expect(result.accepted.size).toBe(count);
    expect(useSaveState.getState().progress).toMatchObject({ done: count, total: count });
    expect(useDraftStore.getState().drafts).toEqual({});
    for (const { hash, next } of changes)
      expect(worker.current()[`tooltips/${hash}.json`]).toEqual(next);
    // Link-only parts are sized by Worker CPU, not by tooltip bytes: a few requests, not hundreds.
    expect(post).toHaveBeenCalledTimes(Math.ceil(count / saveRequestLimits.changes));
  },
);

it('fits about 50 real-size Compendium links in one part and keeps text edits unchanged', () => {
  const text = 'Real tooltip text with a few numbers like 25% and 3 seconds. '.repeat(16);
  const base = makeTooltip(10_001, text);
  const run = { text: 'Compendium cell text, 10% more damage for 5 seconds. ', bold: true };
  const compendium = {
    gid: '1',
    rowKey: 'Row',
    snapshot: { runs: Array.from({ length: 24 }, () => run) },
    snapshotAt: '2026-11-21T12:00:00.000Z',
  } as unknown as Tooltip['compendium'];
  const link: Change = { hash: base.hash, base, next: { ...base, compendium } };
  const edit: Change = { hash: base.hash, base, next: makeTooltip(base.hash, `${text}!`) };
  expect(metadataOnly(link)).toBe(true);
  expect(metadataOnly(edit)).toBe(false);
  const linkCost = saveChangeCost(link);
  expect(linkCost.bytes).toBeGreaterThan(3_000);
  expect(Math.floor(saveRequestLimits.work / linkCost.metadataWork!)).toBeGreaterThanOrEqual(40);
  expect(Math.floor(saveRequestLimits.work / linkCost.metadataWork!)).toBeLessThanOrEqual(60);
  const editBytes = JSON.stringify(edit).length + 1;
  expect(saveChangeCost(edit)).toEqual({
    bytes: editBytes,
    work: editBytes + 512 + 2 * (JSON.stringify(text).length + JSON.stringify(`${text}!`).length),
  });
  // A part with any text edit is costed in full, links included (v2 accounting).
  const links = Array.from({ length: 40 }, (_, i) => {
    const tooltip = makeTooltip(20_000 + i, text);
    return { hash: tooltip.hash, base: tooltip, next: { ...tooltip, compendium } };
  });
  const short: Change = { hash: 1, base: makeTooltip(1, 'A'), next: makeTooltip(1, 'B') };
  expect(fitsSaveRequest(links, 'Save', false)).toBe(true);
  expect(fitsSaveRequest([...links, short], 'Save', false)).toBe(false);
  expect(fitsSaveRequest([...links.slice(0, 3), short], 'Save', false)).toBe(true);
});

it('reports a conflict in a big link part, keeps every draft, and saves the remainder', async () => {
  const changes = realChanges(16);
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
  const conflicted = changes.at(-1)!;
  post
    .mockResolvedValueOnce({
      kind: 'conflicts',
      conflicts: [{ ...conflicted, head: conflicted.base, fields: ['compendium'] }],
    })
    .mockImplementation(async (chunk: Change[]) => ({
      kind: 'saved',
      tooltips: chunk.map(({ next }) => next),
      commit: 'c',
    }));
  const options = {
    message: 'Review Compendium links',
    noTranslationImpact: false,
    sameSession: () => true,
    accountChanged: () => false,
  };
  const review = useSaveState.getState().review!;
  const first = await saveCurrent({ ...options, prepared: changes, review, data });
  expect(first.kind).toBe('conflicts');
  expect(post.mock.calls.map(([chunk]) => (chunk as Change[]).length)).toEqual([16]);
  expect(first.accepted.size).toBe(0);
  expect(first.kind === 'conflicts' && first.kept).toEqual(changes.slice(0, -1));
  expect(useDraftStore.getState().drafts).toEqual(submitted);
  const kept = changes.slice(0, -1);
  useSaveState.setState({
    review: {
      changes: kept,
      submitted: Object.fromEntries(kept.map(({ hash }) => [hash, submitted[hash]])),
    },
  });
  const next = await saveCurrent({
    ...options,
    prepared: kept,
    review: useSaveState.getState().review!,
    data: useDataStore.getState().data!,
  });
  expect(next.kind).toBe('saved');
  expect(useDraftStore.getState().drafts).toEqual({
    [conflicted.hash]: submitted[conflicted.hash],
  });
});

it('keeps the pending receipt of a split part that may have committed', async () => {
  vi.stubGlobal('indexedDB', {});
  const write = vi.spyOn(storage, 'writeSaveReceipt').mockResolvedValue(undefined);
  const changes = realChanges(6);
  const data = loaded();
  useDataStore.setState({ data });
  const submitted = Object.fromEntries(
    changes.map(({ hash, base, next }) => [hash, { base: base!, next }]),
  );
  useDraftStore.setState({
    owner: '1',
    drafts: submitted,
    external: false,
    error: null,
    retry: () => {},
    flush: async () => {},
  });
  reviewSaveChanges(changes, submitted);
  post
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockRejectedValueOnce(new Error('API HTTP 422: Tooltip rejected'));
  const result = await saveCurrent({
    prepared: changes,
    data,
    review: useSaveState.getState().review!,
    message: 'Review Compendium links',
    noTranslationImpact: false,
    sameSession: () => true,
    accountChanged: () => false,
  });
  expect(result.kind).toBe('failed');
  expect(post.mock.calls.map(([chunk]) => (chunk as Change[]).length)).toEqual([6, 3]);
  const [[, id, pending]] = write.mock.calls;
  expect(pending?.tooltips.map(({ hash }) => hash)).toEqual(changes.map(({ hash }) => hash));
  expect(write.mock.calls.filter((call) => call[1] === id && call.length === 2)).toEqual([]);
});

it('retries a metadata-only part that fails on Worker CPU or the network as two halves', async () => {
  const changes = realChanges(9);
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
  post.mockImplementation(async (chunk: Change[]) => {
    if (chunk.length > 5) throw new TypeError('Failed to fetch');
    if (chunk.length > 4) throw new Error('API HTTP 503: error code: 1102');
    return { kind: 'saved', tooltips: chunk.map(({ next }) => next), commit: 'c' };
  });
  const result = await saveCurrent({
    prepared: changes,
    data,
    review: useSaveState.getState().review!,
    message: 'Review Compendium links',
    noTranslationImpact: false,
    sameSession: () => true,
    accountChanged: () => false,
  });
  expect(result.kind).toBe('saved');
  expect(post.mock.calls.map(([chunk]) => (chunk as Change[]).length)).toEqual([9, 5, 3, 2, 4]);
  expect(post.mock.calls.slice(2).flatMap(([chunk]) => chunk)).toEqual(changes);
  expect(useDraftStore.getState().drafts).toEqual({});
});

it.each([422, 502])('does not split after a known Worker %i whose body drops', async (status) => {
  const changes = realChanges(2);
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
  const fetch = vi.fn(async () => {
    const body = new ReadableStream({
      start: (controller) => controller.error(new TypeError('Network error reading body')),
    });
    return new Response(body, { status });
  });
  vi.stubGlobal('fetch', fetch);
  const api = await vi.importActual<typeof import('../api')>('../api');
  post.mockImplementation(api.save);
  const result = await saveCurrent({
    prepared: changes,
    data,
    review: useSaveState.getState().review!,
    message: 'Review Compendium links',
    noTranslationImpact: false,
    sameSession: () => true,
    accountChanged: () => false,
  });
  expect(result).toMatchObject({ kind: 'failed', error: `API HTTP ${status}: ` });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(useDraftStore.getState().drafts).toEqual(submitted);
});

it('does not split a text part or a rejected metadata-only part', async () => {
  const data = loaded();
  useDataStore.setState({ data });
  const options = {
    data,
    message: 'Save',
    noTranslationImpact: false,
    sameSession: () => true,
    accountChanged: () => false,
  };
  const edits = realChanges(4).map(({ hash, base }) => ({
    hash,
    base,
    next: makeTooltip(hash, 'Edited text.'),
  }));
  for (const [changes, error] of [
    [edits, new TypeError('Failed to fetch')],
    [realChanges(4), new Error('API HTTP 422: Tooltip rejected')],
    [realChanges(4), new Error('API HTTP 502: {"error":"Stored tooltip hash mismatch"}')],
  ] as const) {
    post.mockReset().mockRejectedValue(error);
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
    reviewSaveChanges([...changes], submitted);
    const result = await saveCurrent({
      ...options,
      prepared: [...changes],
      review: useSaveState.getState().review!,
    });
    expect(result.kind).toBe('failed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(useDraftStore.getState().drafts).toEqual(submitted);
    useSaveState.getState().close();
  }
});

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

it('saves the importer repair before removing its old export', () => {
  const text = 'Existing text. '.repeat(120);
  const target = makeTooltip(10_001, `export Detail (\nText\n)\n${text}`);
  const importer = makeTooltip(10_002, `import Detail from ${target.hash}\n${text}`);
  const data = loaded();
  data.bundle.tooltips = { [target.hash]: target, [importer.hash]: importer };
  const changes = [
    { hash: target.hash, base: target, next: makeTooltip(target.hash, `New. ${text}`) },
    { hash: importer.hash, base: importer, next: makeTooltip(importer.hash, `Repaired. ${text}`) },
  ];
  expect(
    saveChunks(changes, data, 'Remove an old export', false).map((chunk) =>
      chunk.map(({ hash }) => hash),
    ),
  ).toEqual([[importer.hash], [target.hash]]);
});

it('keeps a simultaneous export rename and importer repair in one bounded request', () => {
  const text = 'Existing text. '.repeat(120);
  const target = makeTooltip(10_001, `export Old (\nText\n)\n${text}`);
  const importer = makeTooltip(10_002, `import Old from ${target.hash}\n${text}`);
  const data = loaded();
  data.bundle.tooltips = { [target.hash]: target, [importer.hash]: importer };
  const changes = [
    {
      hash: target.hash,
      base: target,
      next: makeTooltip(target.hash, `export New (\nText\n)\n${text}`),
    },
    {
      hash: importer.hash,
      base: importer,
      next: makeTooltip(importer.hash, `import New from ${target.hash}\n${text}`),
    },
  ];
  expect(fitsSaveRequest(changes, 'Rename an export', false)).toBe(false);
  const chunks = saveChunks(changes, data, 'Rename an export', false);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toEqual(expect.arrayContaining(changes));
});

it('keeps an oversized closure as drafts while it lands and retries it intact on failure', async () => {
  const text = 'Existing text. '.repeat(400);
  const target = makeTooltip(10_001, `export Old (\nText\n)\n${text}`);
  const importer = makeTooltip(10_002, `import Old from ${target.hash}\n${text}`);
  const data = loaded();
  data.bundle.tooltips = { [target.hash]: target, [importer.hash]: importer };
  const changes = [
    {
      hash: target.hash,
      base: target,
      next: makeTooltip(target.hash, `export New (\nText\n)\n${text}`),
    },
    {
      hash: importer.hash,
      base: importer,
      next: makeTooltip(importer.hash, `import New from ${target.hash}\n${text}`),
    },
  ];
  const submitted = Object.fromEntries(
    changes.map(({ hash, base, next }) => [hash, { base, next }]),
  );
  useDataStore.setState({ data });
  useDraftStore.setState({
    drafts: submitted,
    external: false,
    error: null,
    retry: () => {},
    flush: async () => {},
  });
  reviewSaveChanges(changes, submitted);
  const stage = vi
    .spyOn(staged, 'stageCurrentSave')
    .mockImplementationOnce(async (_id, chunk, _message, _impact, _proceed, progress) => {
      expect(chunk).toEqual(expect.arrayContaining(changes));
      progress(null);
      expect(useSaveState.getState().progress.phase).toBe('landing');
      expect(useDraftStore.getState().drafts).toEqual(submitted);
      return { kind: 'retry', error: 'Action could not apply these drafts' };
    })
    .mockResolvedValueOnce({
      kind: 'saved',
      commit: 'a'.repeat(40),
      tooltips: changes.map(({ next }) => next),
    });
  const options = {
    prepared: changes,
    data,
    review: useSaveState.getState().review!,
    message: 'Rename export',
    noTranslationImpact: false,
    sameSession: () => true,
    accountChanged: () => false,
  };
  expect(await saveCurrent(options)).toMatchObject({ kind: 'failed' });
  expect(useDraftStore.getState().drafts).toEqual(submitted);
  expect(await saveCurrent(options)).toMatchObject({ kind: 'saved' });
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(stage).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
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
  expect(first.accepted.size).toBe((post.mock.calls[0][0] as Change[]).length);
  expect(first.accepted.size).toBeLessThan(changes.length);
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
