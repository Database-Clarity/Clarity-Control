import { afterEach, expect, it, vi } from 'vitest';
import { carryNumberTranslations, reconcileNumberMap } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { clearSavedOverlay } from '../../stores/savedOverlay';
import type { SaveReceipt } from '../draftStorage';
import { editorData, tooltip } from './fixtures.testSupport';
import { startSaveRecovery } from './recovery';
import { draftSaveStatus, useSaveState, visibleDrafts } from './state';
import { openDraftSaveReview } from './openReview';

const read = vi.hoisted(() => vi.fn());
const write = vi.hoisted(() => vi.fn());
const stage = vi.hoisted(() => ({ outcome: vi.fn(), tooltips: vi.fn() }));
vi.mock('../draftStorage', async (actual) => ({
  ...(await actual<typeof import('../draftStorage')>()),
  readSaveReceipts: read,
  writeSaveReceipt: write,
}));
vi.mock('./stagedCurrentSave', () => ({
  readCurrentSaveOutcome: stage.outcome,
  readStagedSavedTooltips: stage.tooltips,
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
  vi.useRealTimers();
  read.mockReset();
  write.mockReset();
  stage.outcome.mockReset();
  stage.tooltips.mockReset();
  useSaveState.setState({ recoveryGeneration: null, applyingDrafts: {} });
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

it('keeps a reopened staged save applying until its immutable receipt confirms the merged tooltip', async () => {
  vi.useFakeTimers();
  const saved = records();
  saved[1] = { ...saved[1], stageId: '01K95H00000000000000000A02' };
  const merged = { ...ambiguous, associated: [123, 789] };
  const commit = 'c'.repeat(40);
  stage.outcome
    .mockResolvedValueOnce({ status: 'queued' })
    .mockResolvedValueOnce({ status: 'saved', commit, savedAt: Date.now() });
  stage.tooltips.mockResolvedValueOnce([merged]);
  start(saved);
  const status = () => draftSaveStatus(useDraftStore.getState(), useSaveState.getState());
  expect(status()).toBe('Checking save');
  openDraftSaveReview();
  expect(useSaveState.getState().review).toBeNull();

  await vi.advanceTimersByTimeAsync(0);
  expect(status()).toBe('Applying');
  expect(
    visibleDrafts(useDraftStore.getState().drafts, useSaveState.getState().applyingDrafts),
  ).toEqual({});
  expect(useDraftStore.getState().drafts[400]?.next).toEqual(ambiguous);
  openDraftSaveReview();
  expect(useSaveState.getState().review).toBeNull();

  await vi.advanceTimersByTimeAsync(4000);
  expect(stage.tooltips).toHaveBeenCalledWith(commit, [400]);
  expect(write).toHaveBeenCalledWith(
    '1',
    'ambiguous',
    expect.objectContaining({ confirmed: true }),
  );
  expect(useDataStore.getState().data!.bundle.tooltips[400]).toEqual(merged);
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(status()).toBeNull();
});

it.each(['saved', 'failed'])(
  'keeps edits made while applying when the stage is %s',
  async (status) => {
    vi.useFakeTimers();
    const saved = records();
    saved[1] = { ...saved[1], stageId: '01K95H00000000000000000A02' };
    stage.outcome
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce(
        status === 'saved'
          ? { status, savedAt: Date.now(), commit: 'c'.repeat(40) }
          : { status, error: 'Save failed' },
      );
    stage.tooltips.mockResolvedValueOnce([{ ...ambiguous, associated: [123, 456] }]);
    start(saved);
    await vi.advanceTimersByTimeAsync(0);
    const next = { ...ambiguous, associated: [123, 789] };
    useDraftStore.setState({ drafts: { 400: { base: second, next } } });
    expect(
      visibleDrafts(useDraftStore.getState().drafts, useSaveState.getState().applyingDrafts)[400]
        ?.next,
    ).toEqual(next);

    await vi.advanceTimersByTimeAsync(4000);
    expect(draftSaveStatus(useDraftStore.getState(), useSaveState.getState())).toBeNull();
    expect(useDraftStore.getState().drafts[400]?.next).toEqual(next);
    expect(write).toHaveBeenCalledTimes(status === 'saved' ? 1 : 0);
  },
);
