import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import { routes } from '../src/App';
import { useCompendiumStore } from '../src/features/compendium/store';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore } from '../src/stores/data';
import { createDraftStore, useDraftStore } from '../src/stores/drafts';
import { watchSystemTheme } from '../src/ui/theme';
import { useSettingsStore } from '../src/stores/settings';
import '../src/ui/global.scss';
import { guidedFixture } from './guided-fixture';

// The real app in a production build with the Compendium proposals stubbed in by the build and a
// fake API: tooltips 100-105 are saved with no English text (Compendium entries), 120 exports a block that
// 121 imports. window.linkSave exposes what the fake server received. No real network or data.
declare global {
  interface Window {
    __linkSaveProposals: unknown;
    linkSave: { saves: unknown[]; draftBatchRemovingImport(donorOnly?: boolean): void; staleBaseDraft(): void };
  }
}
const stamp = '2026-11-01T00:00:00Z';
const fixture = guidedFixture();
window.__linkSaveProposals = fixture.proposals;
const text = (value: string): Tooltip['text'] => ({
  en: { text: value, updatedAt: stamp, updatedBy: 'fixture' },
});
const donor: Tooltip = {
  hash: 120,
  text: text('export foo (\nShared block\n)'),
  associated: [],
};
const user: Tooltip = { hash: 121, text: text('import foo from 120\nUses it'), associated: [] };
const items = {
  ...fixture.editor.items,
  120: {
    hash: 120,
    name: 'Donor 120',
    icon: '',
    categoryId: 'weapon-trait',
    inGameDescription: '',
  },
  121: { hash: 121, name: 'User 121', icon: '', categoryId: 'weapon-trait', inGameDescription: '' },
};
useDataStore.setState({
  data: {
    ...fixture.editor,
    categories: [
      {
        id: 'weapon-trait',
        label: 'Weapon perks',
        group: 'Weapons',
        order: 1,
        legacyType: 'Weapon Trait',
      },
    ],
    items,
    bundle: {
      ...fixture.editor.bundle,
      // Entries whose English is not written yet are saved tooltips with no text (not new ones).
      tooltips: {
        // 103 has no saved tooltip at all (as 209 real items): its link cannot be saved yet.
        ...Object.fromEntries(
          Object.keys(fixture.editor.items)
            .filter((hash) => hash !== '103')
            .map((hash) => [hash, { hash: Number(hash), text: {}, associated: [] } as Tooltip]),
        ),
        // Someone else has written English for 102 since the recovered draft was made.
        102: { hash: 102, text: text('Written by someone else'), associated: [] },
        120: donor,
        121: user,
      },
    },
  },
  status: 'ready',
  error: null,
  load: async () => {},
});
useCompendiumStore.setState({
  data: fixture.source,
  loading: false,
  error: null,
  load: async () => {},
});
const drafts = createDraftStore({ read: async () => ({}), write: async () => {} });
drafts.setState({ hydrated: true });
useDraftStore.setState(drafts.getState());
drafts.subscribe((state) => useDraftStore.setState(state));
useDraftStore.subscribe((state) => {
  const inner = drafts.getState();
  if (state.drafts !== inner.drafts || state.external !== inner.external)
    drafts.setState({ drafts: state.drafts, external: state.external });
});
const noop = async () => {};
useAuthStore.setState({
  loading: false,
  error: null,
  load: noop,
  user: { id: 1, login: 'pat', role: 'editor' },
});

const saves: unknown[] = [];
window.fetch = async (input, init) => {
  if (!String(input).endsWith('/save')) throw new Error('Network blocked by fixture');
  const { changes } = JSON.parse(String(init?.body));
  saves.push(changes);
  return new Response(
    JSON.stringify({
      commit: 'c'.repeat(40),
      tooltips: changes.map((entry: { next: Tooltip }) => entry.next),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
window.linkSave = {
  saves,
  /** 121 gets a link-only draft; 120 drops the block 121 imports (a sibling change in one batch). */
  draftBatchRemovingImport(donorOnly = false) {
    if (!donorOnly) useDraftStore.getState().updateDraft(user, (next) => ({ ...next, associated: [30] }));
    useDraftStore.getState().updateDraft(donor, (next) => ({
      ...next,
      text: text('No export any more'),
    }));
  },
  /** A recovered link-only draft on 102 whose base is empty while the catalogue has English. */
  staleBaseDraft() {
    const empty: Tooltip = { hash: 102, text: {}, associated: [] };
    useDraftStore.setState({
      drafts: { 102: { base: empty, next: { ...empty, associated: [30] } } },
    });
  },
};

watchSystemTheme(() => useSettingsStore.getState().device.theme);
if (!window.location.hash) window.location.hash = '#/compendium?hash=100';
createRoot(document.getElementById('root')!).render(
  createElement(RouterProvider, { router: createHashRouter(routes) }),
);
