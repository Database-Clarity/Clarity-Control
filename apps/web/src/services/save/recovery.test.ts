import { afterEach, expect, it, vi } from 'vitest';
import { carryNumberTranslations, reconcileNumberMap } from '@clarity/core';
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
