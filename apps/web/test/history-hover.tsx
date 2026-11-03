import { createRoot } from 'react-dom/client';
import type { Tooltip } from '@clarity/core';
import { HistoryPanel } from '../src/features/history/HistoryPanel';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import '../src/ui/global.scss';

// Synthetic data only. Needs VITE_API_URL set (any value) so the panel treats the user as signed in.
const stamp = { updatedAt: '2026-10-27T10:00:00Z', updatedBy: 'fixture' };
const words = 'Deals damage to nearby combatants and grants a short burst of speed when defeated';
const revision = (n: number): Tooltip => ({
  hash: 10,
  associated: [],
  text: {
    en: {
      text: `${words
        .split(' ')
        .slice(0, 6 + n)
        .join(' ')}.`,
      ...stamp,
    },
    fr: { text: `Inflige des degats ${'x'.repeat(n)} aux ennemis proches`, ...stamp },
  },
});
const total = 8;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const commits = Array.from({ length: total }, (_, i) => {
  const n = total - i;
  return {
    commit: sha(n),
    author: 'Fixture Author',
    login: null,
    avatar: null,
    date: `2026-10-${10 + n}T12:00:00Z`,
    message:
      n === 5 ? 'A deliberately long commit message that has to wrap inside the list' : `Edit ${n}`,
  };
});
window.fetch = async (input) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  const sha40 = url.searchParams.get('commit');
  const body = sha40
    ? { commit: sha40, tooltip: revision(parseInt(sha40, 16)) }
    : { page: 1, commits };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};

const current = revision(2);
useDataStore.setState({
  data: {
    bundle: { tooltips: { 10: current } },
    items: {},
    aliases: {},
    categories: [],
  } as unknown as EditorData,
  status: 'ready',
});
useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'editor' }, loading: false });
useDraftStore.setState({ drafts: {}, hydrated: true });
const filler = Array.from({ length: 6 }, (_, i) => <p key={i}>Left column row {i + 1}</p>);
createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 300px) 1fr', gap: 12 }}>
    <aside id="column" style={{ minWidth: 0, borderRight: '1px solid var(--line)' }}>
      {filler}
      <HistoryPanel hash={10} />
    </aside>
    <main>
      <p>Editor stand-in</p>
    </main>
  </div>,
);
