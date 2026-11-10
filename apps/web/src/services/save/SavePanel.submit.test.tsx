// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { SaveController } from './SavePanel';
import { useSaveNotice } from './notice';
import { useSaveState, reviewSaveChanges } from './state';
import { openDraftSaveReview } from './openReview';
import { useAuthStore } from '../../stores/auth';
import { conflictSessionKey, useConflictStore } from '../../stores/conflicts';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { editorData, english, tooltip } from './fixtures.testSupport';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
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
  prepareChanges: async (changes: unknown) => changes,
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
  mocks.save.mockResolvedValue({ kind: 'retry', error: 'try later' });
  mocks.token = 'token-a';
  useAuthStore.setState({ user: alice, token: 'token-a', loading: false });
  useDataStore.setState({ data: editorData() });
  useDraftStore.setState({
    drafts: { 123: { base: tooltip, next: edited } },
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
  vi.unstubAllGlobals();
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

  describe('a 409 conflict', () => {
    const line = (text: string) => ({ ...english, text, updatedBy: 'bob' });
    const withText = (text: string, extra = {}) => ({
      ...tooltip,
      text: { en: line(text) },
      ...extra,
    });
    const base = withText('top\nshared\nbottom');
    const head = withText('top\ntheirs\nbottom', { associated: [7] });
    const mine = withText('top\nmine\nbottom');

    beforeEach(() => {
      useDataStore.setState({
        data: {
          ...editorData(),
          bundle: { ...editorData().bundle, tooltips: { 123: base } },
        },
      });
      useDraftStore.setState({
        drafts: { 123: { base, next: mine } },
        retry: () => undefined,
      });
      useConflictStore.setState({ scope: '1', sessions: {} });
    });

    async function review() {
      await act(async () =>
        useSaveState.setState({
          locked: true,
          review: {
            changes: [{ hash: 123, base, next: mine }],
            submitted: { 123: { base, next: mine } },
          },
        }),
      );
      const button = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === 'Save changes',
      );
      await act(async () => button!.click());
    }

    it('closes the review, leaves marker blocks in the draft and saves nothing', async () => {
      mocks.save.mockResolvedValueOnce({
        kind: 'conflicts',
        conflicts: [{ hash: 123, base, head, next: mine, fields: ['text.en'] }],
      });
      await act(async () => root.render(createElement(SaveController)));
      await review();
      expect(useSaveState.getState().review).toBeNull();
      expect(useSaveNotice.getState().notice).toContain('Nothing was saved');
      expect(useSaveNotice.getState().notice).toContain('Resolve 1 conflict');
      const draft = useDraftStore.getState().drafts[123]!;
      expect(draft.base).toEqual(head);
      expect(draft.next.text.en!.text).toContain(
        '<<<<<<< mine\nmine\n=======\ntheirs\n>>>>>>> theirs',
      );
      expect(draft.next.associated).toEqual([7]);
      expect(useDataStore.getState().data!.bundle.tooltips[123]).toEqual(head);
      expect(mocks.save).toHaveBeenCalledTimes(1);
    });

    it('cannot be reviewed again until resolved, then saves on top of theirs', async () => {
      mocks.save.mockResolvedValueOnce({
        kind: 'conflicts',
        conflicts: [{ hash: 123, base, head, next: mine, fields: ['text.en'] }],
      });
      await act(async () => root.render(createElement(SaveController)));
      await review();
      // Still marked: a second review is blocked at validation (the save button stays disabled).
      expect(useConflictStore.getState().open()).toHaveLength(1);
      // The user resolves the block (in the editor this is an ordinary edit of the draft).
      const resolved = {
        ...useDraftStore.getState().drafts[123]!,
        next: withText('top\nmine and theirs\nbottom', { associated: [7] }),
      };
      await act(async () => useDraftStore.setState({ drafts: { 123: resolved } }));
      expect(useConflictStore.getState().open()).toEqual([]);
      mocks.save.mockResolvedValueOnce({
        kind: 'saved',
        commit: 'c'.repeat(40),
        tooltips: [resolved.next],
      });
      await review2(resolved);
      const sent = mocks.save.mock.calls[1]![0][0];
      expect(sent.base).toEqual(head);
      expect(sent.next.text.en.text).toBe('top\nmine and theirs\nbottom');
      expect(useDraftStore.getState().drafts[123]).toBeUndefined();
    });

    async function review2(resolved: { base: Tooltip; next: Tooltip }) {
      await act(async () =>
        useSaveState.setState({
          locked: true,
          review: {
            changes: [{ hash: 123, base: resolved.base, next: resolved.next }],
            submitted: { 123: resolved },
          },
        }),
      );
      const button = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === 'Save changes',
      );
      await act(async () => button!.click());
    }

    it('retains a new one-shot tooltip through a 409, resolution and resave', async () => {
      const created = { ...withText('brand new'), hash: 789 };
      useDraftStore.setState({ drafts: {} });
      mocks.save.mockResolvedValueOnce({
        kind: 'conflicts',
        conflicts: [{ hash: 123, base, head, next: mine, fields: ['text.en'] }],
      });
      await render();
      await act(async () =>
        reviewSaveChanges([
          { hash: 123, base, next: mine },
          { hash: 789, base: null, next: created },
        ]),
      );
      const submit = () =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'Save changes')!
          .click();
      await act(async () => submit());
      expect(useDraftStore.getState().drafts[789]?.next).toEqual(created);
      await act(async () =>
        useDraftStore.setState(({ drafts }) => ({
          drafts: { ...drafts, 123: { base: head, next: withText('resolved') } },
        })),
      );
      mocks.save.mockResolvedValueOnce({
        kind: 'saved',
        commit: 'd'.repeat(40),
        tooltips: [useDraftStore.getState().drafts[123]!.next, created],
      });
      await act(async () => openDraftSaveReview());
      await act(async () => submit());
      expect(mocks.save.mock.calls[1]![0]).toEqual(
        expect.arrayContaining([expect.objectContaining({ hash: 789, base: null, next: created })]),
      );
      expect(useDraftStore.getState().drafts).toEqual({});
    });

    it('resolving this save keeps another tabs unresolved rows in storage', async () => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        get length() {
          return storage.size;
        },
        key: (index: number) => [...storage.keys()][index] ?? null,
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      });
      mocks.save.mockResolvedValueOnce({
        kind: 'conflicts',
        conflicts: [{ hash: 123, base, head: null, next: mine, fields: ['$exists'] }],
      });
      await render();
      // Another tab writes after this tab loaded its sessions, before this save returns 409.
      const other = {
        hash: 789,
        base: null,
        head: { ...head, hash: 789 },
        mine: { ...mine, hash: 789 },
        rows: { $exists: null },
      };
      localStorage.setItem(conflictSessionKey('1', 789), JSON.stringify(other));
      await review();
      await act(async () => useConflictStore.getState().choose(123, '$exists', 'theirs'));
      expect(JSON.parse(localStorage.getItem(conflictSessionKey('1', 789))!)).toEqual(other);
      // Its draft write is external until this tab reloads the other tab's drafts.
      await act(async () => useDraftStore.setState({ external: true }));
      await act(async () => useConflictStore.getState().refresh());
      expect(useConflictStore.getState().open()).toEqual([
        { hash: 789, rows: 1, markers: 0, byLanguage: {}, total: 1 },
      ]);
    });

    it('keeps a deleted-on-server tooltip as a row and blocks saving until answered', async () => {
      mocks.save.mockResolvedValueOnce({
        kind: 'conflicts',
        conflicts: [{ hash: 123, base, head: null, next: mine, fields: ['$exists'] }],
      });
      await act(async () => root.render(createElement(SaveController)));
      await review();
      expect(useDraftStore.getState().drafts[123]!.next).toEqual(mine);
      expect(useConflictStore.getState().open()).toEqual([
        { hash: 123, markers: 0, byLanguage: {}, rows: 1, total: 1 },
      ]);
      // Opening a review for it shows the block and keeps Save disabled.
      await act(async () =>
        useSaveState.setState({
          locked: true,
          review: { changes: [{ hash: 123, base: null, next: mine }], submitted: {} },
        }),
      );
      expect(host.textContent).toContain('Resolve the open conflicts before saving');
      const save = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === 'Save changes',
      );
      expect(save!.disabled).toBe(true);
    });
  });
});

vi.mock('./validationWorker', () => ({ requestSaveValidation: async () => [] }));
