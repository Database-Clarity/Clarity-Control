// The real shell (shell.tsx) plus empty tooltips with agent-written drafts from the local fixture
// in fixtures/editor-drafts (the editor-drafts branch format). No network.
import type { CompendiumData } from '@clarity/core';
import './shell';
import index from './fixtures/editor-drafts/index.json';
import draft3000 from './fixtures/editor-drafts/drafts/3000.json';
import { setEditorDraftFetch } from '../src/services/editorDrafts';
import { useCompendiumStore } from '../src/features/compendium/store';
import { useDataStore } from '../src/stores/data';

const files: Record<string, unknown> = {
  'index.json': index,
  'drafts/3000.json': draft3000,
  // 3001 is listed but its file fails: it must show nothing.
};
const requests: string[] = [];
setEditorDraftFetch(async (path) => {
  requests.push(path);
  const file = files[path];
  return file ? new Response(JSON.stringify(file)) : new Response('', { status: 404 });
});

const data = useDataStore.getState().data!;
const stamp = '2026-11-11T00:00:00Z';
for (const [hash, name] of [
  [3000, 'Bolt Harvest'],
  [3001, 'Unravelling Rounds'],
] as const) {
  data.items[hash] = { hash, name, icon: '', categoryId: 'weapons', inGameDescription: '' };
  data.bundle.tooltips[hash] = { hash, associated: [], text: {} };
}
useDataStore.setState({ data: { ...data } });

const sheet = (text: string) =>
  ({
    fetchedAt: stamp,
    tabs: [
      {
        gid: '1047',
        name: 'Weapon Perks',
        rows: [],
        grid: [{ row: 14, col: 2, colSpan: 3, cell: { plain: text, runs: [{ text }] } }],
      },
    ],
  }) as unknown as CompendiumData;
useCompendiumStore.setState({ data: sheet(draft3000.source.text) });

Object.assign(window, {
  draftFixture: {
    requests,
    sourceChanged() {
      useCompendiumStore.setState({ data: sheet(`${draft3000.source.text} Reworded.`) });
    },
    savedElsewhere(hash: number) {
      const now = useDataStore.getState().data!;
      now.bundle.tooltips[hash] = {
        hash,
        associated: [],
        text: { en: { text: 'Saved in another tab', updatedAt: stamp, updatedBy: 'other' } },
      };
      useDataStore.setState({ data: { ...now, bundle: { ...now.bundle } } });
    },
  },
});
