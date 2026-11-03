// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { CompendiumPanel } from './CompendiumPanel';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { useCompendiumStore } from './store';
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.example',
}));
vi.mock('./LinkPicker', () => ({
  LinkPicker: () => createElement('p', null, 'Choose a different row'),
}));
vi.mock('./CompendiumDiff', async (original) => ({
  ...(await original<typeof import('./CompendiumDiff')>()),
  CompendiumDiff: () => null,
}));
it('preselects a renamed suggestion without drafting or reviewing until Confirm is clicked', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const text = 'Grants increased damage for ten seconds.';
  const base: Tooltip = {
    hash: 123,
    associated: [],
    text: {},
    compendium: {
      gid: '1',
      rowKey: 'Old',
      snapshotAt: '2026-10-01T00:00:00Z',
      snapshot: { plain: text, runs: [{ text }] },
    },
  };
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'editor' } });
  useDataStore.setState({ data: null });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useSaveState.setState({ locked: false, review: null });
  useCompendiumStore.setState({
    loading: false,
    error: null,
    load: async () => {},
    data: {
      fetchedAt: '2026-10-31T00:00:00Z',
      tabs: [
        {
          gid: '2',
          name: 'Arc',
          rows: [
            {
              name: 'Renamed',
              nameNorm: 'renamed',
              rowIndex: 20,
              cell: { plain: text + '!', runs: [{ text: text + '!' }] },
            },
          ],
        },
      ],
    },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(CompendiumPanel, { base })));
    expect(useDraftStore.getState().drafts).toEqual({});
    expect(useSaveState.getState().review).toBeNull();
    expect(host.textContent).not.toContain('Mark as reviewed');
    const button = (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => button('Choose another').click());
    expect(host.textContent).toContain('Choose a different row');
    expect(useDraftStore.getState().drafts).toEqual({});
    await act(async () => button('Confirm suggested relink').click());
    expect(useDraftStore.getState().drafts[123].next.compendium).toMatchObject({
      gid: '2',
      rowKey: 'Renamed',
    });
    expect(base.compendium?.rowKey).toBe('Old');
    expect(useSaveState.getState().review).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
