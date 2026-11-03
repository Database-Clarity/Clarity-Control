import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { routes } from '../src/App';
import { useCompendiumStore } from '../src/features/compendium/store';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { createDraftStore, useDraftStore } from '../src/stores/drafts';
import { watchSystemTheme } from '../src/ui/theme';
import { useSettingsStore } from '../src/stores/settings';
import { useSaveNotice } from '../src/services/save/notice';
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
    tooltips[hash] = tooltip(
      hash,
      `<solar/>${name} deals <pve 6 /> <pvp [4] /> extra <green damage /> with <blue reload speed />,
<yellow 10% /> and <purple void /> <kinetic/><arc/><strand/><void/><stasis/>
<primary/><special/><heavy/> <barrier/><overload/><unstoppable/> <hunter/><titan/><warlock/>
<bold Bold line />`,
    );
    hash++;
  }
}
// Telesto has an enhanced version: the finder marks it +E and lists no entry of its own for it.
items[2000] = {
  hash: 2000,
  name: 'Telesto enhanced',
  icon: '',
  categoryId: 'weapons-enhanced',
  inGameDescription: '',
  baseHash: 1008,
};
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
    {
      id: 'weapons',
      label: 'Weapon perks',
      group: 'Weapons',
      order: 1,
      legacyType: 'Weapon Trait',
    },
    {
      id: 'weapons-enhanced',
      label: 'Enhanced weapon perks',
      group: 'Weapons',
      order: 3,
      legacyType: 'Weapon Trait Enhanced',
    },
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
    /**
     * Enhanced versions on three bases: 2001 derives from 1000 (same text), 2002 keeps its own
     * text over 1001 (an override), 2003 is a blank same-name copy of 1002 (no override UI).
     */
    variants() {
      const own = (hash: number, text: string): Tooltip => ({
        hash,
        text: { en: { text, updatedAt: stamp, updatedBy: 'fixture' } },
        associated: [],
      });
      const entry = (hash: number, name: string, baseHash: number, categoryId: string) => ({
        hash,
        name,
        icon: '',
        categoryId,
        inGameDescription: '',
        baseHash,
      });
      const current = useDataStore.getState().data!;
      useDataStore.setState({
        data: {
          ...current,
          items: {
            ...current.items,
            2001: entry(2001, 'Hammerhead enhanced', 1000, 'weapons-enhanced'),
            2002: entry(2002, 'Forerunner enhanced', 1001, 'weapons-enhanced'),
            2003: entry(2003, 'Whisper of the Worm copy', 1002, 'weapons'),
          },
          bundle: {
            ...current.bundle,
            tooltips: {
              ...current.bundle.tooltips,
              2001: tooltip(2001, current.bundle.tooltips[1000].text.en!.text),
              2002: own(2002, 'Enhanced override text <pve 9 /> <pvp [6] />'),
              2003: { hash: 2003, text: {}, associated: [] },
            },
          },
        },
      });
    },
    /**
     * Gives base 1000 (and its derived enhanced 2001) Kinetic Tremors' text: eight values and one
     * line that only the enhanced version has, for the preview column's Compare view.
     */
    kinetic() {
      const current = useDataStore.getState().data!;
      const text = [
        'Scoring multiple Direct Hits against a target within 3 seconds of each emits 3 damaging shockwaves from its location at the time of activation. Hit counter persists through stow.',
        '',
        'Each shockwave deals up to <pve 90 /> <pvp [20] /> damage in a 6 meter radius. Shockwaves deal 33.33% more damage when activated on Miniboss or higher tier PvE Combatants.',
        '',
        'Hits required for Activation:',
        '• Submachine Guns: #e${14-#d}',
        '• Auto Rifles: #e${12-#d}',
        '• Pulse Rifles: #e${11-#d}',
        '• Sidearms: #e${8-#d}',
        '• Hand Cannons or Scout Rifles (Rapid-Fire and Precision-Frame): #e${6-#d}',
        '• All other Hand Cannons and Scout Rifles: #e${5-#d}',
        '• Rocket Sidearms: #e${4-#d}',
        '• Bows, Sniper Rifles: #e${3-#d}',
        '',
        'var d = 0',
        'var e = 🡅',
        '',
        'enhanced (',
        'var d = 1',
        '#e Hit Requirements are decreased by 1.',
        ')',
      ].join('\n');
      const put = (hash: number): Tooltip => ({
        hash,
        text: { en: { text, updatedAt: stamp, updatedBy: 'fixture' } },
        associated: [],
      });
      useDataStore.setState({
        data: {
          ...current,
          bundle: {
            ...current.bundle,
            tooltips: { ...current.bundle.tooltips, 1000: put(1000), 2001: put(2001) },
          },
        },
      });
    },
    dataError() {
      useDataStore.setState({ error: 'Cannot reach the data bundle', status: 'ready' });
    },
    /** One shell notice by kind; 'none' clears them. */
    notice(kind: 'draft-storage' | 'save' | 'long' | 'settings' | 'all' | 'none') {
      const set = (partial: Partial<ReturnType<typeof useDraftStore.getState>>) =>
        useDraftStore.setState(partial);
      useSaveNotice.getState().dismiss();
      set({ error: null, unowned: 0, previousAccountError: null });
      if (kind === 'draft-storage' || kind === 'all')
        set({ error: 'Drafts could not be written to this browser. Changes are kept in memory.' });
      if (kind === 'save' || kind === 'all')
        useSaveNotice.getState().show('Saved 3 tooltips to review.');
      if (kind === 'long')
        set({
          previousAccountError:
            'A very long explanation of why the previous account could not finish saving its drafts, with a transaction identifier and a hint on what to do next that has to wrap inside the strip instead of widening it.',
        });
      if (kind === 'all') set({ unowned: 2 });
    },
    /** Compendium rows that match 1001 and 1002: a changed cell (long, to scroll) and an unchanged one. */
    compendiumRows() {
      const long = Array.from(
        { length: 14 },
        (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog, again and again.`,
      ).join('\n');
      const cell = (plain: string) => ({ plain, runs: [{ text: plain }] });
      const row = (name: string, plain: string, rowIndex: number) => ({
        name,
        nameNorm: name.toLowerCase(),
        section: '',
        rowIndex,
        cell: cell(plain),
      });
      useCompendiumStore.setState({
        data: {
          tabs: [
            {
              gid: 'g',
              name: 'Weapon Perks',
              rows: [
                row('Row 1001', `Previous changed\n${long}`, 1),
                row('Row 1002', 'Previous', 2),
              ],
              grid: [],
            },
          ],
          fetchedAt: stamp,
        } as unknown as CompendiumData,
      });
    },
    /** Base 1000's German text was written against older English: the English pane offers changes. */
    outdatedTranslation() {
      const current = useDataStore.getState().data!;
      const base = current.bundle.tooltips[1000];
      useDataStore.setState({
        data: {
          ...current,
          bundle: {
            ...current.bundle,
            tooltips: {
              ...current.bundle.tooltips,
              1000: {
                ...base,
                text: {
                  ...base.text,
                  de: { ...base.text.de!, sourceUpdatedAt: '2026-10-01T00:00:00Z' },
                },
              },
            },
          },
        },
      });
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
// A data router, as in main.tsx: the preview leave guard needs useBlocker.
createRoot(document.getElementById('root')!).render(
  createElement(RouterProvider, { router: createHashRouter(routes) }),
);
