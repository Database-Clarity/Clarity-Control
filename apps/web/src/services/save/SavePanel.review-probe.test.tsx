// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveController } from './SavePanel';
import { useSaveNotice } from './notice';
import { useSaveState } from './state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { editorData, tooltip } from './fixtures.testSupport';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  prepare: vi.fn(),
  token: 'token-a' as string | null,
}));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiUrl: 'https://api.example',
  save: mocks.save,
}));
vi.mock('../session', () => ({ sessionToken: () => mocks.token }));
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

const alice = { id: 1, login: 'alice', role: 'editor' as const };
const edited = { ...tooltip, associated: [9] };
let root: Root;
let host: HTMLDivElement;

async function openAndSave() {
  await act(async () =>
    useSaveState.setState({
      locked: true,
      review: {
        changes: [{ hash: 123, base: tooltip, next: edited }],
        submitted: { 123: { base: tooltip, next: edited } },
      },
    }),
  );
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save changes');
  if (!save) throw new Error('Save button missing');
  await act(async () => save.click());
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.save.mockReset();
  mocks.prepare.mockReset().mockImplementation(async (changes: unknown) => changes);
  mocks.save.mockResolvedValue({ kind: 'retry', error: 'try later' });
  mocks.token = 'token-a';
  useAuthStore.setState({ user: alice, token: 'token-a', loading: false });
  useDataStore.setState({ data: editorData() });
  useDraftStore.setState({
    drafts: { 123: { base: tooltip, next: edited } },
    hydrated: true,
    error: null,
    generation: 3,
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

describe('SaveController save submission', () => {
  const render = () => act(async () => root.render(createElement(SaveController)));

  it('sends the save when the login is settled and still the loaded one', async () => {
    await render();
    await openAndSave();
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('refuses to save while the login status is reloading', async () => {
    await render();
    useAuthStore.setState({ loading: true });
    await openAndSave();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Your login changed');
  });

  it('refuses to save when another tab replaced the session token', async () => {
    await render();
    mocks.token = 'token-b';
    await openAndSave();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Your login changed');
  });

  it('reports a save that finished after the account was switched', async () => {
    mocks.save.mockImplementation(async () => {
      useDraftStore.setState({ generation: 4 });
      return { kind: 'saved', commit: 'c'.repeat(40), tooltips: [edited] };
    });
    await render();
    await openAndSave();
    expect(useSaveNotice.getState().notice).toContain('you switched accounts meanwhile');
    expect(useSaveState.getState().review).toBeNull();
    // The previous account's drafts are not reconciled into the new account.
    expect(useDraftStore.getState().drafts[123]).toBeDefined();
  });

  it.each(['flush', 'prepare'] as const)(
    'stops before sending when the account switches during %s',
    async (step) => {
      const switchAccount = () => useDraftStore.setState({ generation: 4 });
      if (step === 'flush')
        useDraftStore.setState({
          flush: async () => {
            switchAccount();
          },
        });
      else
        mocks.prepare.mockImplementation(async (changes: unknown) => {
          switchAccount();
          return changes;
        });
      await render();
      await openAndSave();
      expect(mocks.save).not.toHaveBeenCalled();
      expect(useDraftStore.getState().drafts[123]).toBeDefined();
      expect(useDataStore.getState().data!.bundle.tooltips[123]).toBeDefined();
    },
  );
});

vi.mock('./validationWorker', () => ({ requestSaveValidation: async () => [] }));
