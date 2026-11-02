// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentCategoryControl } from './AttachmentCategoryControl';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import type { Tooltip } from '@clarity/core';
import fixture from '../compendium/fixtures/triage.json';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://editor.test',
}));
const item = fixture.items['2467967826'];
const base: Tooltip = {
  hash: item.hash,
  text: { en: { text: 'Original', updatedAt: '2026-11-02T00:00:00Z', updatedBy: 'author' } },
  associated: [1],
};
let host: HTMLDivElement, root: Root;
const previousAuth = useAuthStore.getState(),
  previousDraft = useDraftStore.getState(),
  previousSave = useSaveState.getState();
const update = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useDraftStore.setState({ drafts: {}, hydrated: true, updateDraft: update });
  useSaveState.setState({ locked: false });
  update.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState(previousAuth);
  useDraftStore.setState(previousDraft);
  useSaveState.setState(previousSave);
});
it('creates only a normal custom.categoryId draft for editor/maintainer and preserves text/associations', async () => {
  for (const role of ['editor', 'maintainer'] as const) {
    useAuthStore.setState({ user: { id: 1, login: 'editor', role } });
    await act(async () => root.render(<AttachmentCategoryControl base={base} item={item} />));
    const button = host.querySelector('button')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    const [original, change] = update.mock.calls.at(-1)!;
    expect(original).toBe(base);
    const laterDraft = {
      ...base,
      associated: [2, 3],
      text: { ...base.text, en: { ...base.text.en!, text: 'Later unsaved English' } },
    };
    expect(change(laterDraft)).toEqual({
      ...laterDraft,
      custom: { name: item.name, categoryId: 'attachment-effect' },
    });
  }
});
it('prevents trial/translator/anonymous promotion and respects hydration/save lock', async () => {
  for (const role of ['trial', 'translator', null] as const) {
    useAuthStore.setState({
      user: role ? { id: 1, login: 'visitor', role, languages: ['en'] } : null,
    });
    await act(async () => root.render(<AttachmentCategoryControl base={base} item={item} />));
    expect(host.querySelector('button')!.disabled).toBe(true);
  }
  useAuthStore.setState({ user: { id: 1, login: 'editor', role: 'editor' } });
  useDraftStore.setState({ hydrated: false });
  await act(async () => root.render(<AttachmentCategoryControl base={base} item={item} />));
  expect(host.querySelector('button')!.disabled).toBe(true);
  useDraftStore.setState({ hydrated: true });
  useSaveState.setState({ locked: true });
  await act(async () => root.render(<AttachmentCategoryControl base={base} item={item} />));
  expect(host.querySelector('button')!.disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});
