// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { disposeSteppingActivity } from '../navigation/steppingActivity';
import { queueState } from '../translations/worklist';

vi.mock('../editor', () => ({
  ClarityEditor: ({ tooltipHash }: { tooltipHash: number }) => <div data-editor={tooltipHash} />,
}));
vi.mock('../preview', () => ({ PreviewColumn: () => null }));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));

it('queue navigation overrides a local variant pick on the same base', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  const tooltip = (hash: number): Tooltip => ({
    hash,
    associated: [],
    text: { en: { text: `English ${hash}`, updatedAt: '2026-02-01T00:00:00Z', updatedBy: 'x' } },
  });
  const data = {
    aliases: {},
    categories: [{ id: 'perks', label: 'Perks', group: 'Weapons', order: 1 }],
    items: {
      10: { hash: 10, name: 'A base', icon: '', categoryId: 'perks', enhancedHashes: [11] },
      11: { hash: 11, name: 'B enhanced', icon: '', categoryId: 'perks', baseHash: 10 },
    },
    bundle: {
      sourceCommit: 'test',
      generatedAt: '2026-02-01T00:00:00Z',
      tooltips: { 10: tooltip(10), 11: tooltip(11) },
      permissions: { users: {} },
      pushed: {},
    },
  } as unknown as EditorData;
  useDataStore.setState({ status: 'ready', data });
  useDraftStore.setState({ hydrated: true, drafts: {} });
  useAuthStore.setState({
    user: { id: 1, login: 'review', role: 'translator', languages: ['de'] },
    loading: false,
  });
  const filters = { state: null, category: null, query: '' };
  const router = createMemoryRouter([{ path: '/t/:hash', element: <TooltipPage /> }], {
    initialEntries: [{ pathname: '/t/10', search: '?lang=de', state: queueState(filters, 10) }],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const clickText = async (text: string) => {
      const button = [...host.querySelectorAll('button')].find(
        (node) => node.textContent === text,
      )!;
      expect(button).toBeDefined();
      await act(async () => button.click());
    };
    await clickText('Edit override');
    expect(host.querySelector('[data-editor="11"]')).not.toBeNull();
    await clickText('Back to base');
    expect(host.querySelector('[data-editor="11"]')).toBeNull();
    const next = host.querySelector<HTMLAnchorElement>('[data-queue] a[aria-label^="Next"]')!;
    expect(next.getAttribute('href')).toBe('/t/10?lang=de&variant=11');
    await act(async () => next.click());
    expect(router.state.location.search).toBe('?lang=de&variant=11');
    expect(host.querySelector('[data-editor="11"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    router.dispose();
    host.remove();
    disposeSteppingActivity();
    vi.unstubAllGlobals();
  }
});
