// @vitest-environment jsdom
// Local integration evidence uses pinned real inputs, passed explicitly by the
// caller. No app files, bundle entries, or data repositories are modified.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipPage } from '../../apps/web/src/features/tooltip/TooltipPage';
import { useDataStore } from '../../apps/web/src/stores/data';
import { useDraftStore } from '../../apps/web/src/stores/drafts';
import { useAuthStore } from '../../apps/web/src/stores/auth';
import { useCompendiumStore } from '../../apps/web/src/features/compendium/store';
import { setEditorDraftFetch } from '../../apps/web/src/services/editorDrafts';

vi.mock('../../apps/web/src/services/api', async (original) => ({
  ...(await original<typeof import('../../apps/web/src/services/api')>()),
  apiUrl: 'https://api.fixture.invalid',
}));
vi.mock('../../apps/web/src/features/editor', () => ({ ClarityEditor: () => <div /> }));
vi.mock('../../apps/web/src/features/preview', () => ({
  PreviewColumn: () => null,
  TooltipPreview: () => null,
}));
vi.mock('../../apps/web/src/features/history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../../apps/web/src/features/compendium/CompendiumPanel', () => ({
  CompendiumPanel: () => null,
}));
vi.mock('../../apps/web/src/features/associations/AssociationsPanel', () => ({
  AssociationsPanel: () => null,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
  setEditorDraftFetch(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it.runIf(!!process.env.BULK_DRAFT_EVIDENCE)(
  'offers Load draft for real catalog-only Set Bonus and Subclass hashes',
  async () => {
    const directory = process.env.BULK_DRAFT_EVIDENCE!;
    const { editor, source } = JSON.parse(
      readFileSync(path.join(directory, 'snapshot.json'), 'utf8'),
    );
    const { items } = JSON.parse(readFileSync(path.join(directory, 'inputs.json'), 'utf8'));
    for (const group of ['Set Bonuses', 'Subclass']) {
      const input = items.find(
        (item: { group: string; hash: number }) =>
          item.group === group && !editor.bundle.tooltips[item.hash],
      );
      expect(input, group).toBeDefined();
      expect(editor.items[input.hash], group).toBeDefined();
      expect(editor.bundle.tooltips[input.hash], group).toBeUndefined();
      const requests: string[] = [];
      setEditorDraftFetch(async (file) => {
        requests.push(file);
        return new Response(
          JSON.stringify(
            file === 'index.json'
              ? { schemaVersion: 1, hashes: [input.hash] }
              : {
                  schemaVersion: 1,
                  hash: input.hash,
                  english: 'Suggested text',
                  sourceCommit: input.sourceCommit,
                  source: input.source,
                  styleGuide: 'v4.5',
                  createdAt: source.fetchedAt,
                  model: 'claude-sonnet-5-5',
                },
          ),
        );
      });
      useDataStore.setState({ status: 'ready', data: editor });
      useDraftStore.setState({ hydrated: true, drafts: {} });
      useCompendiumStore.setState({ data: source, load: async () => {} });
      useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'editor' }, loading: false });
      const host = document.createElement('div');
      document.body.append(host);
      const router = createMemoryRouter([{ path: '/t/:hash', element: <TooltipPage /> }], {
        initialEntries: [`/t/${input.hash}`],
      });
      const root = createRoot(host);
      try {
        await act(async () => root.render(<RouterProvider router={router} />));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        const button = [...host.querySelectorAll('button')].find(
          (node) => node.textContent === 'Load draft…',
        );
        expect(button, `${group}: ${input.hash} ${input.name}`).toBeDefined();
        expect(requests).toEqual(['index.json', `drafts/${input.hash}.json`]);
        expect(useDraftStore.getState().drafts).toEqual({});
        console.log(
          `CATALOG-ONLY PASS ${group}: ${input.hash} ${input.name}; Load draft offered; bundle entry absent; no edit saved.`,
        );
      } finally {
        await act(async () => root.unmount());
        router.dispose();
        host.remove();
      }
    }
  },
  20000,
);
