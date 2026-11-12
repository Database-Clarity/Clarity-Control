// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useCompendiumStore } from '../compendium/store';
import { setEditorDraftFetch, type EditorDraft } from '../../services/editorDrafts';
import type { User } from '../../services/api';

vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.fixture.invalid',
}));
vi.mock('../editor', () => ({
  ClarityEditor: ({ tooltipHash, value }: { tooltipHash: number; value: string }) => (
    <div data-editor={tooltipHash}>{value}</div>
  ),
}));
vi.mock('../preview', () => ({
  PreviewColumn: () => null,
  TooltipPreview: ({ text }: { text: string }) => <div data-draft-preview="">{text}</div>,
}));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));

const stamp = '2026-11-01T00:00:00Z';
const tooltip = (hash: number, en: string): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: en, updatedAt: stamp, updatedBy: 'x' } },
});
const draft = (hash: number): EditorDraft => ({
  schemaVersion: 1,
  hash,
  english: `Drafted text ${hash}`,
  sourceCommit: 'b'.repeat(40),
  source: { tab: 'Weapon Perks', gid: '7', range: 'C3', text: 'Sheet text' },
  styleGuide: 'v1',
  createdAt: stamp,
  model: 'claude-opus-5-5',
});
const compendium = (plain: string) =>
  ({
    fetchedAt: stamp,
    tabs: [
      {
        gid: '7',
        name: 'Weapon Perks',
        rows: [],
        grid: [{ row: 3, col: 2, cell: { plain, runs: [{ text: plain }] } }],
      },
    ],
  }) as unknown as CompendiumData;

let requests: string[];
let offline: boolean;
function setData(tooltips: Record<number, Tooltip>) {
  useDataStore.setState({
    status: 'ready',
    data: {
      aliases: {},
      categories: [{ id: 'perks', label: 'Perks', group: 'Weapons', order: 1 }],
      items: {
        10: { hash: 10, name: 'Empty perk', icon: '', categoryId: 'perks' },
        11: { hash: 11, name: 'Written perk', icon: '', categoryId: 'perks' },
        12: { hash: 12, name: 'Undrafted perk', icon: '', categoryId: 'perks' },
      },
      bundle: {
        sourceCommit: 'test',
        generatedAt: stamp,
        tooltips,
        permissions: { users: {} },
        pushed: {},
      },
    } as unknown as EditorData,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  requests = [];
  offline = false;
  setEditorDraftFetch(async (path) => {
    requests.push(path);
    if (offline) throw new TypeError('Failed to fetch');
    if (path === 'index.json')
      return new Response(JSON.stringify({ schemaVersion: 1, hashes: [10, 11] }));
    if (path === 'drafts/10.json') return new Response(JSON.stringify(draft(10)));
    return new Response('', { status: 404 });
  });
  setData({ 10: tooltip(10, ''), 11: tooltip(11, 'Saved text'), 12: tooltip(12, '') });
  useDraftStore.setState({ hydrated: true, drafts: {} });
  useCompendiumStore.setState({ data: compendium('Sheet text'), load: async () => {} });
  useAuthStore.setState({ user: { id: 1, login: 'pat', role: 'editor' }, loading: false });
});
afterEach(() => {
  setEditorDraftFetch(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(path: string) {
  const router = createMemoryRouter([{ path: '/t/:hash', element: <TooltipPage /> }], {
    initialEntries: [path],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
  const trigger = () =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === 'Load draft…');
  return {
    host,
    router,
    settle,
    trigger,
    async open() {
      await act(async () => trigger()!.click());
      return document.querySelector<HTMLElement>('[role="dialog"]')!;
    },
    async unmount() {
      await act(async () => root.unmount());
      router.dispose();
    },
  };
}

it('offers the draft for an empty tooltip and loads it as an ordinary local edit', async () => {
  const page = await mount('/t/10');
  expect(page.trigger()).toBeUndefined();
  expect(requests).toEqual([]);
  await page.settle();
  expect(requests).toEqual(['index.json', 'drafts/10.json']);
  const dialog = await page.open();
  expect(dialog.querySelector('[data-draft-preview]')?.textContent).toBe('Drafted text 10');
  expect(dialog.textContent).toContain('Weapon Perks');
  expect(dialog.querySelector('a[data-source-ref]')?.getAttribute('href')).toContain(
    'gid=7&range=C3',
  );
  expect(dialog.textContent).not.toContain('Source changed');
  const load = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Load draft')!;
  await act(async () => load.click());
  // Nothing is saved: the text is this tooltip's unsaved draft, and the control is gone.
  expect(useDraftStore.getState().drafts[10]?.next.text.en?.text).toBe('Drafted text 10');
  expect(page.host.querySelector('[data-editor="10"]')?.textContent).toBe('Drafted text 10');
  expect(page.trigger()).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // Discard (or undo back to empty) offers it again, with no new request.
  await act(async () => useDraftStore.getState().discard(10));
  await page.settle();
  expect(page.trigger()).toBeDefined();
  expect(requests).toEqual(['index.json', 'drafts/10.json']);
  await page.unmount();
});

it('says when the Compendium source changed since the draft', async () => {
  useCompendiumStore.setState({ data: compendium('Sheet text, since reworded') });
  const page = await mount('/t/10');
  await page.settle();
  expect((await page.open()).textContent).toContain('Source changed since this draft');
  await page.unmount();
});

it('hides the control once the tooltip has text, here or saved elsewhere', async () => {
  const page = await mount('/t/10');
  await page.settle();
  expect(page.trigger()).toBeDefined();
  await act(async () => setData({ 10: tooltip(10, 'Saved by someone else'), 11: tooltip(11, '') }));
  expect(page.trigger()).toBeUndefined();
  await page.unmount();
});

it('asks nothing for written or undrafted tooltips beyond the one index', async () => {
  for (const path of ['/t/11', '/t/12']) {
    const page = await mount(path);
    await page.settle();
    expect(page.trigger()).toBeUndefined();
    await page.unmount();
  }
  expect(requests).toEqual(['index.json']);
});

it('shows nothing when offline', async () => {
  offline = true;
  const page = await mount('/t/10');
  await page.settle();
  expect(page.trigger()).toBeUndefined();
  await page.unmount();
});

it('is for editors and maintainers only, in English', async () => {
  for (const [user, path, shown] of [
    [{ id: 1, login: 'm', role: 'maintainer' }, '/t/10', true],
    [{ id: 2, login: 't', role: 'trial' }, '/t/10', false],
    [{ id: 3, login: 'l', role: 'translator', languages: ['en', 'de'] }, '/t/10', false],
    [{ id: 4, login: 'n', role: null }, '/t/10', false],
    [{ id: 1, login: 'm', role: 'maintainer' }, '/t/10?lang=de', false],
  ] as const) {
    useAuthStore.setState({ user: JSON.parse(JSON.stringify(user)) as User });
    const page = await mount(path);
    await page.settle();
    expect(Boolean(page.trigger()), `${user.role} ${path}`).toBe(shown);
    await page.unmount();
  }
});
