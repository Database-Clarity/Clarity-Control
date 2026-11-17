import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import type { Permissions, Tooltip } from '@clarity/core';
import { App } from '../src/App';
import { HistoryPanel } from '../src/features/history/HistoryPanel';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { createDraftStore, useDraftStore } from '../src/stores/drafts';
import '../src/ui/global.scss';

// Translation managers render fixture (synthetic data, no network): ?view=translations (the
// Translators popover), ?view=history (History with the upload rollback), ?view=management.
// Needs VITE_API_URL set (any value) so the pages treat the user as signed in.
const view = new URLSearchParams(location.search).get('view') ?? 'translations';
const sha = (n: number) => n.toString(16).padStart(40, '0');
const stamp = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`;
const tooltips: Record<number, Tooltip> = {};
const items: EditorData['items'] = {};
const names = [
  'Kinetic Tremors',
  'Voltshot',
  'Incandescent',
  'Repulsor Brace',
  'Destabilizing Rounds',
  'Chill Clip',
  'Frenzy',
  'One for All',
];
for (let hash = 10; hash <= 40; hash++) {
  tooltips[hash] = {
    hash,
    text: {
      en: {
        text: `Rapid hits with this weapon create a shockwave ${hash} that deals damage to nearby combatants.`,
        updatedAt: stamp(20),
        updatedBy: 'fixture',
      },
      fr: {
        text: `Des tirs rapides créent une onde de choc ${hash} qui inflige des dégâts aux ennemis proches.`,
        updatedAt: stamp(10),
        updatedBy: 'gail',
        sourceUpdatedAt: stamp(5),
      },
    },
    associated: [],
  };
  items[hash] = {
    hash,
    name: `${names[hash % names.length]} ${hash}`,
    icon: '',
    categoryId: 'fixture',
    inGameDescription: '',
  };
}
const data: EditorData = {
  categories: [{ id: 'fixture', label: 'Fixture', group: 'Fixture', order: 1 }],
  items,
  aliases: {},
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips,
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

let translators = [
  { id: 5, login: 'erin-the-manager', languages: ['de', 'fr'], manager: true },
  { id: 7, login: 'gail', languages: ['de', 'fr'], manager: false },
  { id: 8, login: 'a-translator-with-a-very-long-login', languages: ['fr'], manager: false },
  { id: 9, login: 'hana', languages: ['fr', 'ja'], manager: false },
];
const permissions: Permissions = {
  users: {
    '1': { login: 'alice', role: 'maintainer' },
    '2': { login: 'bob', role: 'editor' },
    '5': {
      login: 'erin-the-manager',
      role: 'translator',
      languages: ['de', 'fr'],
      manages: ['fr'],
    },
    '7': { login: 'gail', role: 'translator', languages: ['de', 'fr', 'ja', 'zh-chs'] },
  },
};
const commits = [
  {
    commit: sha(3),
    author: 'gail',
    login: 'gail',
    avatar: null,
    date: '2026-10-12T12:00:00Z',
    message: `Translate the shockwave perks\n\nClarity-Changed: ${[10, 11, 12, 13, 14, 15, 16, 17]
      .map((hash) => `${hash}=fr`)
      .join(';')};18=fr,de`,
  },
  {
    commit: sha(2),
    author: 'alice',
    login: 'alice',
    avatar: null,
    date: '2026-10-08T12:00:00Z',
    message: 'Publish batch',
  },
];
const version = (n: number): Tooltip => ({
  ...tooltips[10]!,
  text: {
    ...tooltips[10]!.text,
    fr: { ...tooltips[10]!.text.fr!, text: n === 3 ? tooltips[10]!.text.fr!.text : 'Ancien texte' },
  },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const plan = {
  upload: sha(3),
  lang: 'fr',
  reverted: [10, 11, 12, 13, 14, 15, 16, 17],
  skipped: [{ hash: 18, reason: 'changed-later' }],
};
const writes: string[] = [];
(window as unknown as { writes: string[] }).writes = writes;
window.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  const method = init?.method ?? 'GET';
  // Every write the page sends, for the harness (the mock replaces the network).
  if (method !== 'GET') writes.push(`${method} ${url.pathname}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (url.pathname.endsWith('/translators/fr')) {
    if (method === 'POST') {
      const { login } = JSON.parse(String(init!.body)) as { login: string };
      if (login === 'bob') return json({ error: 'Managers can change only translators' }, 403);
      translators = [...translators, { id: 50, login, languages: ['fr'], manager: false }];
    }
    return json({ lang: 'fr', translators });
  }
  const remove = /\/translators\/fr\/(\d+)$/.exec(url.pathname);
  if (remove) {
    translators = translators.filter((t) => t.id !== Number(remove[1]));
    return json({ lang: 'fr', translators });
  }
  if (url.pathname.endsWith('/rollback/upload'))
    return method === 'POST'
      ? json({ ...plan, commit: sha(9), tooltips: plan.reverted.map((h) => tooltips[h]) })
      : json(plan);
  if (url.pathname.endsWith('/permissions')) return json({ revision: sha(7), permissions });
  if (url.pathname.includes('/history/')) {
    const commit = url.searchParams.get('commit');
    return commit
      ? json({ commit, tooltip: version(parseInt(commit, 16)) })
      : json({ page: 1, commits });
  }
  return json({ error: 'not in fixture' }, 404);
};

useDataStore.setState({ data, status: 'ready', load: async () => {} });
useAuthStore.setState({
  user:
    view === 'management'
      ? { id: 1, login: 'alice', role: 'maintainer' }
      : {
          id: 5,
          login: 'erin-the-manager',
          role: 'translator',
          languages: ['de', 'fr'],
          manages: ['fr'],
        },
  loading: false,
  load: async () => {},
});
// An in-memory draft store, as the shell fixture uses: the App activates it for the user.
const drafts = createDraftStore({ read: async () => ({}), write: async () => {} });
drafts.setState({ hydrated: true });
useDraftStore.setState(drafts.getState());
drafts.subscribe((state) => useDraftStore.setState(state));

const root = createRoot(document.getElementById('root')!);
if (view === 'history')
  root.render(
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 320px) 1fr', gap: 12 }}>
      <aside style={{ minWidth: 0, borderRight: '1px solid var(--line)' }}>
        <HistoryPanel hash={10} language="fr" />
      </aside>
      <main>
        <p>Editor stand-in</p>
      </main>
    </div>,
  );
else {
  window.location.hash =
    view === 'management' ? '#/management' : '#/translations?lang=fr&state=outdated';
  root.render(createElement(HashRouter, null, createElement(App)));
}
