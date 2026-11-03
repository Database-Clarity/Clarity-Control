import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import { Layout } from '../src/features/navigation/Layout';
import { ReviewPage } from '../src/features/review/ReviewPage';
import { usePublishState } from '../src/features/review/publishDriver';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import type { PublishOp } from '../src/services/publisher/opStore';
import '../src/ui/global.scss';

// Static render fixture: seeds the publish state directly (no driver, no network) so every
// status line can be looked at and measured at once.
window.fetch = async () => {
  throw new Error('Network blocked by the publisher render fixture');
};
const now = Date.now();
const timestamp = '2026-11-01T00:00:00Z';
const tooltips: Record<number, Tooltip> = {};
const items: EditorData['items'] = {};
for (let hash = 100; hash < 124; hash++) {
  tooltips[hash] = {
    hash,
    associated: [],
    text: { en: { text: `Saved edit ${hash}`, updatedAt: timestamp, updatedBy: 'fixture' } },
  };
  items[hash] = {
    hash,
    name:
      hash === 103
        ? 'A deliberately long tooltip name that must not push controls apart'
        : `Sample ${hash}`,
    icon: '',
    categoryId: 'fixture',
    inGameDescription: 'Synthetic',
  };
}
const queued = new Date(now - 12 * 60_000).toISOString();
const data: EditorData = {
  categories: [{ id: 'fixture', label: 'Synthetic category', group: 'Fixture', order: 1 }],
  items,
  aliases: {},
  bundle: {
    sourceCommit: 'synthetic',
    generatedAt: timestamp,
    tooltips,
    permissions: { users: {} },
    pushed: {},
    publishQueue: [
      {
        opId: '01M6GMFKGZJPP01N49ZMR9Z9TS',
        requester: { id: 9, login: 'other' },
        hashes: [100],
        createdAt: queued,
      },
    ],
  },
};
const op = (n: number, status: PublishOp['status'], patch: Partial<PublishOp> = {}): PublishOp => ({
  opId: `01M6GMFKG${n}JPP01N49ZMR9Z9TS`.slice(0, 26),
  userId: '1',
  createdAt: now - n * 60_000,
  hashes: Array.from({ length: n + 1 }, (_, i) => 100 + i),
  expected: {},
  previous: {},
  status,
  updatedAt: now,
  ...patch,
});
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'all';
const states: PublishOp[] =
  mode === 'one'
    ? [op(1, 'pending', { acceptedAt: now - 20_000 })]
    : [
        op(0, 'created'),
        op(1, 'pending', { acceptedAt: now - 20_000 }),
        op(5, 'pending', { acceptedAt: now - 5 * 60_000 }),
        op(2, 'done'),
        op(3, 'unchanged'),
        op(4, 'stale'),
        op(6, 'rejected', {
          error:
            'The publisher refused this request: a tooltip with no generator entry cannot be published.',
        }),
        op(7, 'failed', {
          error:
            'The publish run failed after repeated attempts; check the run log, then publish these tooltips again.',
        }),
      ];
useDataStore.setState({ data, status: 'ready', error: null, load: async () => {} });
useAuthStore.setState({
  user: { id: 1, login: 'fixture', role: 'maintainer' },
  loading: false,
  error: null,
  load: async () => {},
});
useDraftStore.setState({
  drafts: {},
  hydrated: true,
  pending: 0,
  error: null,
  hydrate: async () => {},
  activate: async () => {},
});
usePublishState.setState({
  userId: '1',
  hydrated: true,
  ops: states,
  notes: { [states[0]!.opId]: 'Offline; retrying.' },
  storageError: undefined,
});
declare global {
  interface Window {
    __setOpStatus?: (index: number, status: PublishOp['status']) => void;
  }
}
window.__setOpStatus = (index, status) =>
  usePublishState.setState((state) => ({
    ops: state.ops.map((entry, i) => (i === index ? { ...entry, status } : entry)),
  }));
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/review?hash=100']}>
    <Routes>
      <Route element={<Layout />}>
        <Route path="review" element={<ReviewPage />} />
      </Route>
    </Routes>
  </MemoryRouter>,
);
document.body.dataset.ready = '1';
