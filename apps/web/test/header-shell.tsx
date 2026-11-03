import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { App } from '../src/App';
import { useCompendiumStore } from '../src/features/compendium/store';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { createDraftStore, useDraftStore } from '../src/stores/drafts';
import { watchSystemTheme } from '../src/ui/theme';
import { useSettingsStore } from '../src/stores/settings';
import '../src/ui/global.scss';

// The real app shell on synthetic data: roles, counts, long names, errors and drafts are driven
// from the screenshot script through window.shellFixture. No network.
window.fetch = async () => {
  throw new Error('Network blocked by header fixture');
};

const stamp = '2026-10-27T00:00:00Z';
const tooltip = (hash: number, text: string): Tooltip => ({
  hash,
  text: {
    en: { text, updatedAt: stamp, updatedBy: 'fixture' },
    de: { text: `${text} (de)`, updatedAt: stamp, updatedBy: 'fixture' },
  },
  associated: [],
});
const weapons = [
  'Hammerhead',
  'Forerunner',
  'Whisper of the Worm',
  'Outbreak Perfected',
  'Ticuu’s Divination with an exceptionally long name that has to truncate somewhere',
  'Fatebringer',
  'Gjallarhorn',
  'Thunderlord',
  'Telesto',
  'Sunshot',
];
const armor = ['Celestial Nighthawk', 'Star-Eater Scales', 'Bones of Eao', 'Mask of Bakris'];
const items: EditorData['items'] = {};
const tooltips: Record<number, Tooltip> = {};
let hash = 1000;
for (const [category, names] of [
  ['weapons', weapons],
  ['armor', armor],
] as const) {
  for (const name of names) {
    items[hash] = { hash, name, icon: '', categoryId: category, inGameDescription: '' };
    tooltips[hash] = tooltip(hash, `<pve>${name}</pve> deals extra damage.`);
    hash++;
  }
}
const first = 1000;
// Items whose Compendium link no longer resolves count as changes.
for (const link of [1001, 1002, 1003]) {
  tooltips[link].compendium = {
    gid: 'g',
    rowKey: `Row ${link}`,
    snapshot: { plain: 'Previous', runs: [{ text: 'Previous' }] },
    snapshotAt: stamp,
  } as Tooltip['compendium'];
}
const data: EditorData = {
  categories: [
    { id: 'weapons', label: 'Weapon perks', group: 'Weapons', order: 1 },
    { id: 'armor', label: 'Exotic armor', group: 'Armor', order: 2 },
  ],
  items,
  aliases: {},
  bundle: {
    sourceCommit: '4c2a540b7d1e',
    generatedAt: stamp,
    tooltips,
    permissions: { users: {} },
    pushed: {},
  },
};
useDataStore.setState({ data, status: 'ready', error: null, load: async () => {} });
useCompendiumStore.setState({
  data: { tabs: [], fetchedAt: stamp } as unknown as CompendiumData,
  loading: false,
  error: null,
  load: async () => {},
});
const drafts = createDraftStore({ read: async () => ({}), write: async () => {} });
drafts.setState({ hydrated: true });
useDraftStore.setState(drafts.getState());
drafts.subscribe((state) => useDraftStore.setState(state));

type Role = 'maintainer' | 'editor' | 'trial' | 'translator' | 'none' | 'out' | 'loading' | 'error';
const noop = async () => {};
Object.assign(window, {
  shellFixture: {
    first,
    role(role: Role) {
      const base = { loading: false, error: null, load: noop };
      if (role === 'out') useAuthStore.setState({ ...base, user: null });
      else if (role === 'loading') useAuthStore.setState({ ...base, user: null, loading: true });
      else if (role === 'error')
        useAuthStore.setState({ ...base, user: null, error: 'Login service unreachable' });
      else if (role === 'none')
        useAuthStore.setState({ ...base, user: { id: 5, login: 'newcomer', role: null } });
      else if (role === 'translator')
        useAuthStore.setState({
          ...base,
          user: { id: 4, login: 'linguist-with-a-long-name', role, languages: ['de', 'fr'] },
        });
      else useAuthStore.setState({ ...base, user: { id: 1, login: 'pat', role } });
    },
    drafts(count: number) {
      const next: Record<number, { base: Tooltip; next: Tooltip }> = {};
      for (let i = 0; i < count; i++) {
        const h = first + i;
        const base = tooltips[h];
        next[h] = {
          base,
          next: {
            ...base,
            text: {
              ...base.text,
              de: {
                text: 'Geändert',
                updatedAt: `2026-11-0${(i % 3) + 1}T10:00:00Z`,
                updatedBy: 'pat',
              },
            },
          },
        };
      }
      useDraftStore.setState({ drafts: next });
    },
    recovered() {
      const base = { hash: 9999, text: {}, associated: [] } as Tooltip;
      useDataStore.setState({
        data: { ...data, aliases: { 9999: { to: first, kind: 'frame' } } },
      });
      useDraftStore.setState({
        drafts: {
          ...useDraftStore.getState().drafts,
          9999: {
            base,
            next: {
              ...base,
              text: { en: { text: 'Recovered work to keep', updatedAt: stamp, updatedBy: 'x' } },
            },
          },
        },
      });
    },
    dataError() {
      useDataStore.setState({ error: 'Cannot reach the data bundle', status: 'ready' });
    },
    compendiumError() {
      useCompendiumStore.setState({ error: 'Cannot load Compendium: offline' });
    },
  },
});
(window as unknown as { shellFixture: { role(role: Role): void } }).shellFixture.role('maintainer');

// Same wiring as main.tsx.
watchSystemTheme(() => useSettingsStore.getState().device.theme);

window.location.hash = `#/t/${first}`;
createRoot(document.getElementById('root')!).render(
  createElement(HashRouter, null, createElement(App)),
);
