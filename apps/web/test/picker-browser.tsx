import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { CompendiumData, Tooltip } from '@clarity/core';
import type { EditorData } from '../src/stores/data';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import { LinkPicker } from '../src/features/compendium/LinkPicker';
import { CompendiumTab } from '../src/features/compendium/CompendiumTab';
import { CompendiumQueue } from '../src/features/compendium/CompendiumQueue';
import { useCompendiumStore } from '../src/features/compendium/store';
import layout from '../src/features/navigation/Layout.module.scss';
import '../src/ui/global.scss';

const timestamp = '2026-11-01T00:00:00Z';
const cell = (text: string) => ({ plain: text, runs: [{ text, bold: true as const }] });
const source: CompendiumData = {
  fetchedAt: timestamp,
  tabs: [
    {
      gid: '1662574278',
      name: 'Weapon Perks',
      rows: [
        {
          name: 'Sample 100',
          nameNorm: 'sample 100',
          rowIndex: 100,
          section: 'General mechanics',
          anchor: { row: 100, col: 0 },
          cell: cell('First part'),
        },
      ],
      grid: [
        { row: 100, col: 0, cell: cell('Sample 100') },
        { row: 100, col: 1, cell: cell('First part '.repeat(80)) },
        { row: 101, col: 1, cell: cell('Second part') },
      ],
    },
  ],
};
source.tabs.push({ ...source.tabs[0], gid: 'other-sheet', name: 'Other sheet' });
const base: Tooltip = { hash: 101, text: {}, associated: [] };
const editor: EditorData = {
  categories: [{ id: 'weapon-trait', label: 'Synthetic traits', group: 'Fixture', order: 1 }],
  aliases: {},
  items: {
    101: {
      hash: 101,
      name: 'Sample 101',
      categoryId: 'weapon-trait',
      inGameDescription: 'Long synthetic description. '.repeat(400),
      icon: '',
    },
  },
  bundle: {
    sourceCommit: 'synthetic',
    generatedAt: timestamp,
    permissions: { users: {} },
    pushed: {},
    tooltips: { 101: base },
  },
};
useAuthStore.setState({ user: null });
useDataStore.setState({ data: editor });
useDraftStore.setState({ hydrated: true, drafts: {} });
useCompendiumStore.setState({ data: source });
// This small synthetic fixture exercises the normal synchronous matching fallback.
// Real-data production performance gates keep the application's worker path enabled.
Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });

function Fixture() {
  const [ordinary, setOrdinary] = useState(false);
  const location = useLocation();
  return (
    <div className={`${layout.layout} ${layout.reviewMode}`}>
      <aside className={layout.sidebar} data-open="false">
        <header className={layout.brand}>
          <strong>Clarity fixture</strong>
        </header>
        <div className={layout.saveDock} aria-label="Synthetic save dock">
          <p>Save dock fixture</p>
          <button disabled>Review and save drafts</button>
        </div>
      </aside>
      <aside className={layout.left}>
        <CompendiumQueue />
      </aside>
      <main className={layout.main}>
        <button onClick={() => setOrdinary(!ordinary)}>Toggle ordinary picker</button>
        {ordinary ? (
          <LinkPicker base={base} name="Sample 100" category="weapon-trait" onLinked={() => {}} />
        ) : (
          <CompendiumTab />
        )}
        <output data-fixture-route>{location.pathname}</output>
      </main>
    </div>
  );
}

Object.assign(window, {
  pickerFixture: {
    read: () => ({ drafts: useDraftStore.getState().drafts }),
  },
});
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/compendium']}>
    <Fixture />
  </MemoryRouter>,
);
