// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { SaveController } from './SavePanel';
import { useSaveState } from './state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { editorData, english, tooltip } from './fixtures.testSupport';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  prepare: vi.fn(),
  validate: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiUrl: 'https://api.example',
  save: mocks.save,
}));
vi.mock('../session', () => ({ sessionToken: () => 'token-a' }));
vi.mock('./pipeline', () => ({
  permissionError: () => null,
  validateChanges: () => [],
  prepareChanges: mocks.prepare,
}));
vi.mock('./validationWorker', () => ({ requestSaveValidation: mocks.validate }));
vi.mock('./SaveSummary', () => ({ SaveSummary: () => null }));
vi.mock('../../ui/Dialog', () => ({
  Dialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) =>
    createElement('div', null, children, footer),
}));

const translated: Tooltip = {
  ...tooltip,
  text: {
    en: english,
    de: {
      text: 'Deutsch',
      updatedAt: english.updatedAt,
      updatedBy: 'dan',
      sourceUpdatedAt: english.updatedAt,
    },
  },
};
const reworded: Tooltip = {
  ...translated,
  text: { ...translated.text, en: { ...english, text: 'Original English, fixed' } },
};
let root: Root;
let host: HTMLDivElement;

async function open(
  base: Tooltip,
  next: Tooltip,
  role: 'editor' | 'maintainer' | 'trial' = 'editor',
) {
  useAuthStore.setState({
    user: { id: 1, login: 'alice', role },
    token: 'token-a',
    loading: false,
  });
  await act(async () => root.render(createElement(SaveController)));
  await act(async () =>
    useSaveState.setState({
      locked: true,
      review: { changes: [{ hash: 123, base, next }], submitted: { 123: { base, next } } },
    }),
  );
}
const tick = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]');
const saveButton = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.save.mockReset().mockResolvedValue({ kind: 'retry', error: 'try later' });
  mocks.prepare.mockReset().mockImplementation(async (changes: unknown) => changes);
  mocks.validate.mockReset().mockResolvedValue([]);
  useDataStore.setState({
    data: { ...editorData(), bundle: { ...editorData().bundle, tooltips: { 123: translated } } },
  });
  useDraftStore.setState({
    drafts: { 123: { base: translated, next: reworded } },
    hydrated: true,
    error: null,
    generation: 3,
    owner: '1',
    external: false,
    flush: async () => {},
  });
  useSaveState.setState({ locked: false, review: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useSaveState.setState({ locked: false, review: null });
});

describe('"No translation impact" in the save review', () => {
  it('is offered to editors and maintainers for English wording on a translated tooltip', async () => {
    for (const role of ['editor', 'maintainer'] as const) {
      await open(translated, reworded, role);
      expect(host.querySelector(`label[for="${tick()?.id}"]`)?.textContent).toBe(
        'No translation impact',
      );
      expect(tick()?.checked).toBe(false);
      expect(host.textContent).toContain('History marks this save');
    }
  });
  it('is never offered to trials, translation-only saves, or tooltips without translations', async () => {
    await open(translated, reworded, 'trial');
    expect(tick()).toBeNull();
    const german = {
      ...translated,
      text: { ...translated.text, de: { ...translated.text.de!, text: 'Neu' } },
    };
    await open(translated, german);
    expect(tick()).toBeNull();
    const lone = { ...tooltip };
    await open(lone, { ...lone, text: { en: { ...english, text: 'Changed' } } });
    expect(tick()).toBeNull();
  });
  it('unticked: prepares and sends the save exactly as before', async () => {
    await open(translated, reworded);
    await act(async () => saveButton().click());
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      { noTranslationImpact: false },
    );
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'Update 1 tooltip(s)', false);
    // German is based on English from 2026-01-01: a new English revision now puts it over the
    // 90-day gap, so the review validates its live English fallback.
    expect(mocks.validate.mock.calls.at(-1)?.[2]).toEqual({ 123: ['de'] });
  });
  it('ticked: stamps with the tick and sends the flag', async () => {
    await open(translated, reworded);
    await act(async () => tick()!.click());
    expect(tick()!.checked).toBe(true);
    await act(async () => saveButton().click());
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      { noTranslationImpact: true },
    );
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'Update 1 tooltip(s)', true);
    // Ticked, English keeps its revision: nothing falls back, the review revalidates without it.
    expect(mocks.validate.mock.calls.at(-1)?.[2]).toEqual({});
  });
});
