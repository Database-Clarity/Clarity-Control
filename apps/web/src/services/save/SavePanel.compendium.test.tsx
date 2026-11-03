// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumCell, CompendiumData, Tooltip } from '@clarity/core';
import { SavePanel } from './SavePanel';
import { useSaveState } from './state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useCompendiumStore } from '../../features/compendium/store';
import { editorData, english } from './fixtures.testSupport';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  load: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiUrl: 'https://api.example',
  save: mocks.save,
}));
vi.mock('../session', () => ({ sessionToken: () => 'token-a' }));
vi.mock('../compendium', () => ({ loadCompendium: mocks.load }));
vi.mock('./pipeline', () => ({
  permissionError: () => null,
  validateChanges: () => [],
  prepareChanges: mocks.prepare,
}));
vi.mock('./SaveSummary', () => ({ SaveSummary: () => null }));
vi.mock('../../ui/Dialog', () => ({
  Dialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) =>
    createElement('div', null, children, footer),
}));

const cell = (text: string): CompendiumCell => ({ plain: text, runs: [{ text }] });
const source = (text: string, fetchedAt: string): CompendiumData => ({
  fetchedAt,
  tabs: [
    {
      gid: '1',
      name: 'Tab',
      rows: [{ name: 'Test', nameNorm: 'test', rowIndex: 1, cell: cell(text) }],
    },
  ],
});
const linked: Tooltip = {
  hash: 123,
  text: { en: english },
  associated: [],
  compendium: {
    gid: '1',
    rowKey: 'Test',
    snapshot: cell('reviewed'),
    snapshotAt: '2026-01-01T00:00:00Z',
  },
};
const alice = { id: 1, login: 'alice', role: 'editor' as const };
let root: Root;
let host: HTMLDivElement;

const button = (label: string) => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`${label} button missing: ${host.textContent}`);
  return found;
};
const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]');
async function open(next: Tooltip) {
  await act(async () =>
    useSaveState.setState({
      locked: true,
      review: {
        changes: [{ hash: 123, base: linked, next }],
        submitted: { 123: { base: linked, next } },
      },
    }),
  );
}
const englishEdit = (): Tooltip => ({
  ...linked,
  text: { en: { ...english, text: 'Edited English' } },
});
const clickSave = () => act(async () => button('Save changes').click());

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.save.mockReset();
  mocks.save.mockImplementation(async () => ({
    kind: 'saved',
    commit: 'c'.repeat(40),
    tooltips: [englishEdit()],
  }));
  mocks.load.mockReset();
  mocks.prepare.mockReset();
  mocks.prepare.mockImplementation(async (changes: unknown) => changes);
  useAuthStore.setState({ user: alice, token: 'token-a', loading: false });
  useDataStore.setState({ data: editorData() });
  useDraftStore.setState({
    drafts: { 123: { base: linked, next: englishEdit() } },
    hydrated: true,
    error: null,
    generation: 3,
    flush: async () => {},
  });
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({ data: source('shown', '2026-10-01T00:00:00Z') });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({ data: null });
});

describe('saving over a Compendium source that changed since it was shown', () => {
  const render = () => act(async () => root.render(createElement(SavePanel)));

  it('saves straight away when the source is what the editor was shown', async () => {
    const fresh = source('shown', '2026-10-02T00:00:00Z');
    mocks.load.mockResolvedValue(fresh);
    await render();
    await open(englishEdit());
    await clickSave();
    expect(mocks.load).toHaveBeenCalledWith(true);
    expect(host.textContent).not.toContain('Compendium source changed');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    // The exact data that was compared is what gets recorded, and the panel now follows it.
    expect(mocks.prepare.mock.calls[0][3]).toBe(fresh);
    expect(useCompendiumStore.getState().data).toBe(fresh);
  });

  it('shows the new diff and records nothing until it is acknowledged', async () => {
    const fresh = source('newer', '2026-10-02T00:00:00Z');
    mocks.load.mockResolvedValue(fresh);
    await render();
    await open(englishEdit());
    await clickSave();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Compendium source changed');
    expect(host.textContent).toContain('newer');
    expect(host.textContent).toContain('nothing was saved');
    expect(checkbox()?.checked).toBe(false);
    expect(button('Save changes').disabled).toBe(true);
    // The panel keeps comparing against what the editor was shown until something is recorded.
    expect(useCompendiumStore.getState().data?.fetchedAt).toBe('2026-10-01T00:00:00Z');

    await act(async () => checkbox()!.click());
    expect(button('Save changes').disabled).toBe(false);
    await clickSave();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.prepare.mock.calls[0][3]).toBe(fresh);
    expect(useCompendiumStore.getState().data).toBe(fresh);
  });

  it('asks again when the source moves on after the tick', async () => {
    mocks.load.mockResolvedValue(source('newer', '2026-10-02T00:00:00Z'));
    await render();
    await open(englishEdit());
    await clickSave();
    await act(async () => checkbox()!.click());
    mocks.load.mockResolvedValue(source('newest', '2026-10-03T00:00:00Z'));
    await clickSave();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('newest');
    expect(checkbox()?.checked).toBe(false);
    expect(button('Save changes').disabled).toBe(true);
  });

  it('compares with the reviewed snapshot when the Compendium was never loaded', async () => {
    useCompendiumStore.setState({ data: null });
    mocks.load.mockResolvedValue(source('reviewed', '2026-10-02T00:00:00Z'));
    await render();
    await open(englishEdit());
    await clickSave();
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('asks about a change nobody was shown, even when the Compendium was never loaded', async () => {
    useCompendiumStore.setState({ data: null });
    mocks.load.mockResolvedValue(source('unseen', '2026-10-03T00:00:00Z'));
    await render();
    await open(englishEdit());
    await clickSave();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('unseen');
  });

  it('leaves saves that cannot record a snapshot alone', async () => {
    await render();
    const translated: Tooltip = {
      ...linked,
      text: { ...linked.text, de: { ...english, text: 'Deutsch' } },
    };
    await open(translated);
    await clickSave();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.prepare.mock.calls[0][3]).toBeUndefined();
  });
});
