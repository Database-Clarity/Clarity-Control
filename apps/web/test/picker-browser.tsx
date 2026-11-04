import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { CompendiumData, Tooltip } from '@clarity/core';
import type { EditorData } from '../src/stores/data';
import { useAuthStore } from '../src/stores/auth';
import { useDraftStore } from '../src/stores/drafts';
import { CategoryReview } from '../src/features/compendium/CategoryReview';
import { LinkPicker } from '../src/features/compendium/LinkPicker';
import { ReviewQueue } from '../src/features/compendium/MatchReviewPage';
import { GuidancePersistence } from '../src/features/compendium/guidancePersistence';
import { reviewCategories } from '../src/features/compendium/reviewCategories';
import { reviewQueue } from '../src/features/compendium/reviewQueue';
import { emptyProgress, sourceFingerprint } from '../src/features/compendium/reviewProgress';
import { useCompendiumStore } from '../src/features/compendium/store';
import styles from '../src/features/compendium/MatchReview.module.scss';
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
const entries = reviewQueue(editor, source, {}, emptyProgress(), sourceFingerprint(source.tabs));
const proposals = new Map();
const categories = reviewCategories(entries, editor, proposals, false);
let stored: unknown = null;
const persistence = new GuidancePersistence(
  'synthetic-picker',
  'synthetic-memory',
  { getItem: () => null, setItem: () => {} },
  async (_input, init) => {
    if (init?.method === 'POST') stored = JSON.parse(String(init.body)).document;
    return Response.json({ document: stored, revision: stored ? 'synthetic-revision' : null });
  },
);
useAuthStore.setState({ user: null });
useDraftStore.setState({ hydrated: true, drafts: {} });
useCompendiumStore.setState({ data: source });
// This small synthetic fixture exercises the normal synchronous matching fallback.
// Real-data production performance gates keep the application's worker path enabled.
Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });

function Fixture() {
  const [ordinary, setOrdinary] = useState(false);
  const [entriesMode, setEntriesMode] = useState(false);
  const location = useLocation();
  const state = useSyncExternalStore(persistence.subscribe, persistence.getSnapshot);
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
      <main className={layout.main}>
        <article
          className={`${styles.review} ${entriesMode ? styles.entryReview : styles.categoryReview}`}
        >
          <header className={styles.heading}>
            <h1>Synthetic sample review</h1>
            <button onClick={() => setOrdinary(!ordinary)}>Toggle ordinary picker</button>
            <button onClick={() => setEntriesMode(!entriesMode)}>Toggle entry review</button>
          </header>
          {entriesMode ? (
            <ReviewQueue editor={editor} source={source} storageKey="synthetic-review-progress" />
          ) : ordinary ? (
            <LinkPicker base={base} name="Sample 100" category="weapon-trait" onLinked={() => {}} />
          ) : (
            <CategoryReview
              categories={categories}
              editor={editor}
              source={source}
              proposals={proposals}
              guidance={{ ...state, persistence }}
              onReview={() => {}}
            />
          )}
        </article>
        <output data-fixture-route>{location.pathname}</output>
      </main>
    </div>
  );
}

await persistence.start();
persistence.synchronize(
  categories.map((category) => ({
    id: category.id,
    name: category.name,
    rule: category.rule,
    count: category.entries.length,
    hashes: category.entries.map((entry) => entry.hash),
    active: true,
  })),
  'synthetic-baseline',
);
Object.assign(window, {
  pickerFixture: {
    read: () => ({
      document: persistence.getSnapshot().document,
      drafts: useDraftStore.getState().drafts,
    }),
  },
});
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/compendium?view=entries']}>
    <Fixture />
  </MemoryRouter>,
);
