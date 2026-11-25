import { afterEach, expect, it, vi } from 'vitest';
import { carryNumberTranslations, reconcileNumberMap } from '@clarity/core';
import { pendingTooltips } from '../../features/review/model';
import { useReviewQueue } from '../../features/review/queueStore';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { clearSavedOverlay } from '../../stores/savedOverlay';
import type { SaveReceipt } from '../draftStorage';
import { editorData, tooltip } from './fixtures.testSupport';
import { startSaveRecovery } from './recovery';
import { useSaveState } from './state';

const read = vi.hoisted(() => vi.fn());
vi.mock('../draftStorage', async (actual) => ({
  ...(await actual<typeof import('../draftStorage')>()),
  readSaveReceipts: read,
}));

const second = { ...tooltip, hash: 400 };
const confirmed = { ...tooltip, associated: [400] };
const ambiguous = { ...second, associated: [123] };
const records = (): SaveReceipt[] => [
  {
    id: 'confirmed',
    at: Date.now(),
    confirmed: true,
    tooltips: [confirmed],
    submitted: { 123: { base: tooltip, next: confirmed } },
  },
  {
    id: 'ambiguous',
    at: Date.now(),
    confirmed: false,
    tooltips: [ambiguous],
    submitted: { 400: { base: second, next: ambiguous } },
  },
];
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  useReviewQueue.getState().clearSelection();
  useReviewQueue.setState({ entries: null });
  useAuthStore.setState({ user: null, loading: false });
  clearSavedOverlay();
  vi.unstubAllGlobals();
  read.mockReset();
});

function start(saved = records()) {
  vi.stubGlobal('indexedDB', {});
  useSaveState.getState().close();
  const fixture = editorData();
  const data = {
    ...fixture,
    bundle: {
      ...fixture.bundle,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
      tooltips: { 123: tooltip, 400: second },
    },
  };
  read.mockResolvedValueOnce(saved);
  useDataStore.setState({ data });
  useDraftStore.setState({
    drafts: { ...saved[0].submitted, ...saved[1].submitted },
    retry: vi.fn(),
    owner: '1',
    hydrated: true,
    generation: 1,
    external: false,
    error: null,
  });
  stop = startSaveRecovery();
  return data;
}

it('restores a confirmed chunk before the static bundle catches up and keeps an uncertain one', async () => {
  const data = start();
  await Promise.resolve();
  expect(read).toHaveBeenCalledWith('1');
  expect(useDataStore.getState().data!.bundle.tooltips[123]).toEqual(confirmed);
  expect(useDraftStore.getState().drafts[123]).toBeUndefined();
  expect(useDraftStore.getState().drafts[400]?.next).toEqual(ambiguous);

  useDataStore.setState({
    data: {
      ...data,
      bundle: { ...data.bundle, tooltips: { 123: confirmed, 400: ambiguous } },
    },
  });
  expect(useDraftStore.getState().drafts).toEqual({});
});

it('recognizes a lost response after the Worker carries numbered translations', async () => {
  const en = { ...tooltip.text.en!, text: 'Damage 10.' };
  const base = {
    ...second,
    text: { en, de: { ...en, text: 'Schaden #{=1}.', sourceUpdatedAt: en.updatedAt } },
  };
  const next = {
    ...base,
    text: {
      ...base.text,
      en: { ...en, text: 'Damage 20.', updatedAt: '2026-01-02T00:00:00.000Z' },
    },
  };
  const saved = records();
  saved[1] = { ...saved[1], tooltips: [next], submitted: { 400: { base, next } } };
  const data = start(saved);
  await Promise.resolve();
  const raw = structuredClone(next);
  Object.assign(raw.text.en, { numbers: reconcileNumberMap(base.text.en, raw.text.en, raw) });
  const carried = carryNumberTranslations(base, raw);
  expect(carried.carried).toEqual(['de']);
  useDataStore.setState({
    data: {
      ...data,
      bundle: { ...data.bundle, tooltips: { 123: confirmed, 400: carried.tooltip } },
    },
  });
  expect(useDraftStore.getState().drafts).toEqual({});
});

it('clears a confirmed draft when only its local change time changed', async () => {
  start();
  useDraftStore.setState(({ drafts }) => ({
    drafts: {
      ...drafts,
      123: { ...drafts[123], changedAt: new Date().toISOString() },
    },
  }));
  await Promise.resolve();
  expect(useDraftStore.getState().drafts[123]).toBeUndefined();
});

it('retains an edited draft even when its previously submitted content arrives', async () => {
  const data = start();
  const editedLater = { ...ambiguous, associated: [123, 789] };
  useDraftStore.setState(({ drafts }) => ({
    drafts: { ...drafts, 400: { base: second, next: editedLater } },
  }));
  await Promise.resolve();
  useDataStore.setState({
    data: {
      ...data,
      bundle: { ...data.bundle, tooltips: { 123: confirmed, 400: ambiguous } },
    },
  });
  expect(useDraftStore.getState().drafts[400]?.next).toEqual(editedLater);
});

it('keeps a Review tick when recovery replays an obsolete acknowledged save', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const user = { id: 1, login: 'fixture', role: 'editor' as const };
  const latest = { ...tooltip, associated: [1234] };
  const first = records();
  // Save 1's receipt remains in IndexedDB for 24 hours after save 2 catches up in the bundle.
  first[0] = { ...first[0], at: Date.now() - 16 * 60 * 1000 };
  const data = start(first);
  const latestData = {
    ...data,
    bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 123: latest } },
  };
  stop?.();
  read.mockResolvedValueOnce(first);
  useDataStore.setState({ data: latestData });
  useAuthStore.setState({ user, loading: false });
  const queue = useReviewQueue.getState();
  const entries = await pendingTooltips(latestData);
  expect(entries.find(({ tooltip }) => tooltip.hash === 123)?.tooltip).toEqual(latest);
  queue.setEntries(entries);
  queue.toggle(123);
  expect(useReviewQueue.getState().selected.has(123)).toBe(true);
  expect(storage.size).toBe(1);
  stop = startSaveRecovery();
  await Promise.resolve();
  expect(useDataStore.getState().data!.bundle.tooltips[123]).toEqual(latest);
  expect(storage.size).toBe(1);
  expect(useReviewQueue.getState().selected.has(123)).toBe(true);
});
