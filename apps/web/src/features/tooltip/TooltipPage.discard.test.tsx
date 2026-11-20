// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { setEditorDraftFetch } from '../../services/editorDrafts';

// The real editor: Discard must be one of its undo steps.
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.fixture.invalid',
}));
vi.mock('../preview', () => ({ PreviewColumn: () => null, TooltipPreview: () => null }));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));

const stamp = '2026-11-01T00:00:00Z';
const tooltip = (hash: number, en: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: en, updatedAt: stamp, updatedBy: 'x' } },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  setEditorDraftFetch(async () => new Response('', { status: 404 }));
  useDataStore.setState({
    status: 'ready',
    data: {
      aliases: {},
      categories: [{ id: 'perks', label: 'Perks', group: 'Weapons', order: 1 }],
      items: { 11: { hash: 11, name: 'Written perk', icon: '', categoryId: 'perks' } },
      bundle: {
        sourceCommit: 'test',
        generatedAt: stamp,
        tooltips: { 11: tooltip(11, 'Saved text') },
        permissions: { users: {} },
        pushed: {},
      },
    } as unknown as EditorData,
  });
  useDraftStore.setState({ hydrated: true, drafts: {} });
  useAuthStore.setState({ user: { id: 1, login: 'pat', role: 'editor' }, loading: false });
});
afterEach(() => {
  setEditorDraftFetch(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('discards as one editor step: undo restores the text and the draft, redo discards again', async () => {
  const router = createMemoryRouter([{ path: '/t/:hash', element: <TooltipPage /> }], {
    initialEntries: ['/t/11'],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
  const type = (text: string) =>
    act(async () =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.type',
      }),
    );
  const draftText = () => useDraftStore.getState().drafts[11]?.next.text.en?.text;
  const dot = () => host.querySelector('[aria-label="Unsaved draft"]');
  const button = (scope: ParentNode, name: string) =>
    [...scope.querySelectorAll('button')].find(
      (b) => b.textContent === name || b.getAttribute('aria-label') === name,
    );

  // Two typed steps; the second one is the text that Discard drops.
  await type(' one');
  await type(' two\n  ünïcode ✓');
  const typed = 'Saved text one two\n  ünïcode ✓';
  expect(draftText()).toBe(typed);
  expect(dot()).not.toBeNull();

  await act(async () => button(host, 'Discard this draft')!.click());
  const confirm = document.querySelector('[role="group"][aria-label="Discard this draft?"]')!;
  await act(async () => button(confirm, 'Discard')!.click());
  expect(view.state.doc.toString()).toBe('Saved text');
  expect(useDraftStore.getState().drafts[11]).toBeUndefined();
  expect(dot()).toBeNull();

  // Undo brings back exactly the discarded text, as a draft again.
  await act(async () => void undo(view));
  expect(view.state.doc.toString()).toBe(typed);
  expect(draftText()).toBe(typed);
  expect(dot()).not.toBeNull();
  // The history before the discard is intact.
  await act(async () => void undo(view));
  expect(view.state.doc.toString()).toBe('Saved text one');
  expect(draftText()).toBe('Saved text one');
  await act(async () => void redo(view));
  expect(draftText()).toBe(typed);
  // Redo discards again.
  await act(async () => void redo(view));
  expect(view.state.doc.toString()).toBe('Saved text');
  expect(useDraftStore.getState().drafts[11]).toBeUndefined();
  expect(dot()).toBeNull();

  await act(async () => root.unmount());
  router.dispose();
});
