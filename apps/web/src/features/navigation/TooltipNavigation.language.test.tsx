// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Lang } from '@clarity/core';
import { TooltipPage } from '../tooltip/TooltipPage';
import { WorkspaceLanguageProvider } from '../tooltip/WorkspaceLanguage';
import { TooltipNavigation } from './TooltipNavigation';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { disposeSteppingActivity } from './steppingActivity';
import { picker } from './finderPicker.testUtils';
vi.mock('../editor', () => ({ ClarityEditor: () => null }));
vi.mock('../preview', () => ({ PreviewColumn: () => null }));
vi.mock('../history/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../compendium/CompendiumPanel', () => ({ CompendiumPanel: () => null }));
vi.mock('../associations/AssociationsPanel', () => ({ AssociationsPanel: () => null }));
vi.mock('../tooltip/EditorPaneHeader', () => ({
  EditorPaneHeader: ({ lang, onLanguage }: { lang: Lang; onLanguage(lang: Lang): void }) => (
    <button data-language={lang} onClick={() => onLanguage('de')}>
      German
    </button>
  ),
}));
const data = {
  aliases: {},
  categories: [
    { id: 'weapon-trait-exotic', label: 'Exotic Weapon Perks', group: 'Weapons', order: 1 },
  ],
  items: {
    10: {
      hash: 10,
      name: 'Test',
      icon: '',
      categoryId: 'weapon-trait-exotic',
      inGameDescription: 'Effect',
      itemHash: 1000,
      itemName: 'Weapon',
      owners: [1000],
      ownerNames: { 1000: 'Weapon' },
    },
  },
  bundle: {
    sourceCommit: 'test',
    generatedAt: '2026-11-15',
    permissions: { users: {} },
    pushed: {},
    tooltips: {
      10: {
        hash: 10,
        associated: [],
        text: {
          en: { text: 'English', updatedAt: '2026-11-15', updatedBy: 'x' },
          de: {
            text: 'Deutsch',
            updatedAt: '2026-11-14',
            updatedBy: 'x',
            sourceUpdatedAt: '2026-11-13',
          },
        },
      },
    },
  },
} as unknown as EditorData;
const originalData = useDataStore.getState();
const originalDrafts = useDraftStore.getState();
const originalAuth = useAuthStore.getState();
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useDataStore.setState({ status: 'ready', data });
  useDraftStore.setState({ hydrated: true, drafts: {} });
  useAuthStore.setState({ user: { id: 1, login: 'test', role: 'editor' }, loading: false });
  router = createMemoryRouter(
    [
      {
        path: '/t/:hash',
        element: (
          <>
            <TooltipNavigation data={data} />
            <TooltipPage />
          </>
        ),
      },
      { path: '/other', element: <div>Other workspace</div> },
    ],
    { initialEntries: ['/t/10'] },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <WorkspaceLanguageProvider>
        <RouterProvider router={router} />
      </WorkspaceLanguageProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  router.dispose();
  host.remove();
  disposeSteppingActivity();
  useDataStore.setState(originalData);
  useDraftStore.setState(originalDrafts);
  useAuthStore.setState(originalAuth);
  vi.unstubAllGlobals();
});
const navigate = (to: string | number) =>
  act(async () => {
    if (typeof to === 'number') await router.navigate(to);
    else await router.navigate(to);
  });
async function expectView(lang: Lang, outdated: boolean) {
  expect(host.querySelector('[data-language]')!.getAttribute('data-language')).toBe(lang);
  const field = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  if (field.getAttribute('aria-expanded') !== 'true') await act(async () => field.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  expect(!!host.querySelector('[role="option"] [aria-label="Outdated"]')).toBe(outdated);
  for (const label of ['Category', 'Weapon']) {
    const trigger = picker(host, label)!;
    expect(trigger).not.toBeNull();
    await act(async () => trigger.click());
    const list = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    const options = [...list.querySelectorAll('[role="option"]')];
    expect(options.length).toBeGreaterThan(0);
    for (const option of options)
      expect(!!option.querySelector('[aria-label="Outdated"]')).toBe(outdated);
    await act(async () => trigger.click());
  }
}
it('keeps entry, category, and group markers on the displayed language across Back and Forward', async () => {
  await expectView('en', false);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-language]')!.click());
  expect(router.state.location.search).toBe('?lang=de');
  await expectView('de', true);
  await navigate(-1);
  expect(router.state.location.search).toBe('');
  await expectView('de', true);
  await navigate(1);
  await expectView('de', true);
  await navigate('/t/10?lang=en');
  await expectView('en', false);
  await navigate(-1);
  await expectView('de', true);
  await navigate('/t/10?lang=fr');
  await expectView('fr', false);
  await navigate(-1);
  await expectView('de', true);
  await navigate(1);
  await expectView('fr', false);
});
it('forgets the choice when the workspace unmounts, matching the original local-state lifetime', async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-language]')!.click());
  await expectView('de', true);
  await navigate('/other');
  await navigate('/t/10');
  await expectView('en', false);
});
