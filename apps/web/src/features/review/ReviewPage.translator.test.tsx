// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishableHash, translationPublishReasons, type Tooltip } from '@clarity/core';
import type { User } from '../../services/api';
import type { Bundle } from '../../services/bundle';
import { loadBundle } from '../../services/bundle';
import { loadGenerator } from '../../services/generator';
import type { PendingTranslation, ReadyTranslation } from '../../services/translationPublish';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { clearSavedOverlay, rememberSaved } from '../../stores/savedOverlay';
import { Layout } from '../navigation/Layout';
import { useKinds } from './kinds';
import { publishDriver } from './publisher';
import { usePublishState } from './publishDriver';
import { resetPublished } from './published';
import { useReviewQueue } from './queueStore';
import { ReviewPage } from './ReviewPage';
import { useReviewSession } from './session';

vi.mock('../../services/generator', () => ({ loadGenerator: vi.fn() }));
vi.mock('../../services/bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/bundle')>()),
  loadBundle: vi.fn(),
}));
vi.mock('../../services/globalsFlag', async (original) => ({
  ...(await original<typeof import('../../services/globalsFlag')>()),
  globalsEnabled: true,
}));
vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://synthetic.invalid',
  loginUrl: () => 'https://synthetic.invalid/auth/login',
  apiRequest: (path: string, init: RequestInit) => fetch(`https://synthetic.invalid${path}`, init),
}));
vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => null,
}));
vi.mock('../compendium/CompendiumBadge', () => ({
  CompendiumBadge: () => null,
  CompendiumWarmup: () => null,
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));

const stamp = { updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'fixture' };
const later = { ...stamp, updatedAt: '2026-02-01T00:00:00Z', sourceUpdatedAt: stamp.updatedAt };
const en = { text: 'English', ...stamp };
const digest = (letter: string) => letter.repeat(64);

const ready = (
  id: { hash: number } | { id: string },
  lang: 'de' | 'fr',
  extra: Partial<ReadyTranslation> = {},
) =>
  ({
    ...('hash' in id ? { kind: 'tooltip' } : { kind: 'global', affected: digest('f') }),
    ...id,
    lang,
    status: 'ready',
    expected: digest('a'),
    english: digest('b'),
    before: digest('c'),
    effects: digest('d'),
    removed: false,
    englishFallback: false,
    affectedHashes: [],
    ...extra,
  }) as ReadyTranslation;

const capability = { version: 'translation-publish-v1' as const, partRows: 2 };
const translator: User = {
  id: 1,
  login: 'translator',
  role: 'translator',
  languages: ['de'],
  translationPublish: capability,
};
const editor: User = { id: 1, login: 'editor', role: 'editor' };

/** 10: German changed. 20: English changed too, so it waits. 30: German removed. 40: French only. */
const live: Record<number, Tooltip> = Object.fromEntries(
  [10, 20, 30, 40].map((hash) => [
    hash,
    {
      hash,
      associated: [],
      text: {
        en,
        ...(hash === 40 ? { fr: { text: 'Vieux', ...later } } : { de: { text: 'Alt', ...later } }),
      },
    },
  ]),
);
const saved: Record<number, Tooltip> = {
  10: { ...live[10]!, text: { en, de: { text: 'Neu', ...later } } },
  20: {
    ...live[20]!,
    text: { en: { text: 'Other', ...later }, de: { text: 'Neu', ...later } },
  },
  30: { ...live[30]!, text: { en } },
  40: { ...live[40]!, text: { en, fr: { text: 'Nouveau', ...later } } },
};

let bundle: Bundle;
let root: Root;
let host: HTMLDivElement;
let calls: { path: string; method: string; body?: unknown }[];
let answer: (body: { opId: string; rows: { hash?: number; lang: string }[] }) => Response;
let search = '';

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await flush();
    check();
  });
}
const buttons = () => [...host.querySelectorAll('button')];
const button = (label: string) => buttons().find((b) => b.textContent?.startsWith(label));
async function click(label: string) {
  const found = button(label);
  if (!found) throw Error(`Missing button ${label}: ${host.textContent}`);
  await act(async () => found.click());
  await flush();
}
async function key(name: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true }));
  });
  await flush();
}
const rowKeys = () =>
  [...host.querySelectorAll('a[data-review-hash]')].map((row) =>
    row.getAttribute('data-review-hash'),
  );
const row = (id: string) => host.querySelector<HTMLAnchorElement>(`a[data-review-hash="${id}"]`);
const box = (id: string) =>
  row(id)!.parentElement!.querySelector<HTMLInputElement>('input[data-review-toggle]')!;
const tick = async (id: string) => {
  await act(async () => box(id).click());
  await flush();
};
const detail = () => host.querySelector('section[aria-label="Selected change"]');
const head = () => host.querySelector<HTMLButtonElement>('button[data-review-publish]');
const dialog = () => host.querySelector('dialog[open]');
const posts = () =>
  calls.filter(({ path, method }) => method === 'POST' && path.startsWith('/publish'));

function Where() {
  search = useLocation().search;
  return null;
}
async function mount(route = '/review') {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [route] },
        createElement(Where),
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(Layout) },
            createElement(Route, { path: '/review', element: createElement(ReviewPage) }),
          ),
        ),
      ),
    ),
  );
  await waitFor(() => {
    expect(useDataStore.getState().status).toBe('ready');
    expect(host.querySelector('article[aria-busy=true]')).toBeNull();
  });
  await flush();
}
async function signIn(user: User | null) {
  await act(async () => useAuthStore.setState({ user, loading: false, load: async () => {} }));
  if (user) await publishDriver.start(String(user.id), user.role === 'translator');
  else publishDriver.stop();
}
const lanes = (rows: PendingTranslation[]) => {
  const result: NonNullable<Bundle['translationPublish']>['lanes'] = {};
  for (const entry of rows) (result[entry.lang] ??= []).push(entry);
  return result;
};
const waiting: PendingTranslation = {
  kind: 'tooltip',
  hash: 20,
  lang: 'de',
  status: 'waiting',
  reason: translationPublishReasons['english-pending'],
};

beforeEach(async () => {
  vi.stubEnv('VITE_PUBLISHER_ENABLED', '1');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  for (const [name, open] of [
    ['showModal', true],
    ['close', false],
  ] as const)
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.toggleAttribute('open', open);
      },
    });
  sessionStorage.clear();
  clearSavedOverlay();
  resetPublished();
  useKinds.setState({ byHash: {} });
  useReviewSession.setState({
    acknowledgments: {},
    globals: {},
    translations: {},
    pushing: false,
    notice: undefined,
    error: undefined,
  });
  useAuthStore.setState({ user: null, loading: false, load: async () => {} });
  useReviewQueue.getState().clearSelection();
  useReviewQueue.setState({
    entries: null,
    collapsed: new Set(),
    leftovers: 'hidden',
    translations: 'hidden',
  });
  bundle = {
    sourceCommit: 'baseline',
    generatedAt: '2026-01-01T00:00:00Z',
    tooltips: structuredClone(saved),
    pushed: Object.fromEntries(
      await Promise.all(
        Object.values(live).map(async (entry) => [entry.hash, await publishableHash(entry)]),
      ),
    ),
    permissions: { users: {} },
    globalsPending: [],
    translationPublish: {
      version: 'translation-publish-v1',
      liveCommit: 'e'.repeat(40),
      lanes: lanes([
        ready({ hash: 10 }, 'de'),
        waiting,
        ready({ hash: 30 }, 'de', { removed: true }),
        ready({ hash: 40 }, 'fr'),
      ]),
      only: { tooltips: [10, 30, 40], globals: [] },
    },
  };
  vi.mocked(loadGenerator).mockResolvedValue({
    categories: [],
    items: Object.fromEntries(
      [10, 20, 30, 40].map((hash) => [
        hash,
        { hash, name: `Tooltip ${hash}`, categoryId: 'other', icon: '', inGameDescription: '' },
      ]),
    ) as never,
    aliases: {},
  });
  vi.mocked(loadBundle).mockImplementation(async () => structuredClone(bundle));
  useDataStore.setState({ data: null, status: 'idle', error: null });
  useDraftStore.setState({
    hydrated: true,
    hydrate: async () => {},
    activate: async () => {},
    drafts: {},
  });
  calls = [];
  answer = ({ opId }) => Response.json({ opId, status: 'pending' }, { status: 202 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('https://synthetic.invalid', '');
      const version = /^\/history\/(\d+)\?live=1/.exec(path);
      if (version)
        return Response.json({
          tooltip: live[Number(version[1])] ?? null,
          pushedHash: bundle.pushed[version[1]!] ?? null,
        });
      if (path.startsWith('/history/')) return Response.json({ page: 1, commits: [] });
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ path, method: init?.method ?? 'GET', body });
      if (path.startsWith('/publish?')) return answer(body);
      if (path.startsWith('/publish/status'))
        return Response.json({
          operations: [{ opId: new URL(url).searchParams.get('opId'), status: 'pending' }],
        });
      throw Error(`Blocked network: ${url}`);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  publishDriver.stop();
  await act(async () => root.unmount());
  host.remove();
  await act(async () => useAuthStore.setState({ user: null }));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('lists only the rows of the assigned language, with the blocked ones and their reason', async () => {
  await signIn(translator);
  await mount();
  expect(rowKeys()).toEqual(['10:de', '20:de', '30:de']);
  // Only the publishable rows count; no language picker for one language.
  expect(host.querySelector('article > header p')?.textContent).toMatch(/^2 changes ready/);
  expect(host.querySelector('select[aria-label="Language"]')).toBeNull();
  expect(box('20:de').disabled).toBe(true);
  expect(row('20:de')!.title).toContain(translationPublishReasons['english-pending']);
  await waitFor(() => expect(detail()?.textContent).toContain('Text changed in German'));
  expect(detail()?.textContent).toContain('Neu');
  // It opens its own language in the editor.
  expect(host.querySelector('a[data-review-edit="10:de"]')?.getAttribute('data-review-path')).toBe(
    '/t/10?lang=de',
  );
});

it('compares with the published text beside live English, not with an English change that waits', async () => {
  await signIn(translator);
  await mount('/review?hash=30%3Ade');
  await waitFor(() =>
    expect(detail()?.textContent).toContain('Removes the German translation. Players see English'),
  );
  expect(detail()?.textContent).toContain('Alt');
  expect(detail()?.textContent).not.toContain('English comparison');
  expect(host.querySelector('section[aria-label="English comparison"]')).toBeNull();
});

it('reports a Still correct save as a row without a text change', async () => {
  bundle.tooltips[10] = {
    ...live[10]!,
    text: { en, de: { ...live[10]!.text.de!, sourceUpdatedAt: later.updatedAt } },
  };
  await signIn(translator);
  await mount('/review?hash=10%3Ade');
  await waitFor(() =>
    expect(detail()?.textContent).toContain('Marks the German translation as still correct'),
  );
  expect(row('10:de')!.textContent).toContain('Still correct');
});

it('says when a translation goes live in English', async () => {
  const old = { text: 'Neu', ...later, sourceUpdatedAt: '2025-01-01T00:00:00Z' };
  bundle.tooltips[10] = { ...live[10]!, text: { en, de: old } };
  bundle.translationPublish!.lanes = lanes([ready({ hash: 10 }, 'de', { englishFallback: true })]);
  await signIn(translator);
  await mount();
  await waitFor(() => expect(detail()?.textContent).toContain('Goes live in English.'));
});

it('opens a named row by its language, and never another account’s row from the URL', async () => {
  await signIn(translator);
  await mount('/review?hash=40%3Afr&lang=fr');
  expect(rowKeys()).not.toContain('40:fr');
  expect(search).toContain('hash=10%3Ade');
  await act(async () => root.render(createElement('div')));
  await mount('/review?hash=20');
  expect(search).not.toMatch(/hash=20(&|$)/);
});

it.each([
  ['Restore live text as draft', () => button('Restore live text as draft')],
  ['whole-tooltip comparison', () => host.querySelector('section[lang="en"]')],
  ['editor requests waiting', () => host.querySelector('li[data-status="foreign"]')],
  ['folded lines', () => button('Show')],
])('never shows a translator: %s', async (_, find) => {
  bundle.publishQueue = [
    {
      opId: '01M88X6RPQE4DM9GKW4K71BP53',
      requester: { id: 9, login: 'editor' },
      hashes: [20],
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];
  await signIn(translator);
  await mount();
  await waitFor(() => expect(detail()?.textContent).toContain('Neu'));
  expect(find() ?? null).toBeNull();
});

it('offers several languages a filter, and names each row’s language', async () => {
  await signIn({ ...translator, languages: ['de', 'fr'] });
  await mount();
  expect(rowKeys()).toEqual(['10:de', '20:de', '30:de', '40:fr']);
  expect(row('40:fr')!.textContent).toContain('French');
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
  expect([...select.options].map(({ text }) => text)).toEqual([
    'All languages',
    'German (2)',
    'French (1)',
  ]);
  await act(async () => {
    select.value = 'fr';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
  expect(rowKeys()).toEqual(['40:fr']);
  expect(search).toContain('lang=fr');
  await waitFor(() => expect(detail()?.querySelector('[lang="fr"]')).not.toBeNull());
  await click('Include all 1');
  await act(async () => head()!.click());
  expect(dialog()?.textContent).toContain('1 French translation goes live');
  expect(dialog()?.textContent).toContain('40 · French');
});

it('sends exactly the reviewed facts of the confirmed rows, once', async () => {
  await signIn(translator);
  await mount();
  await tick('10:de');
  expect(head()!.textContent).toContain('Publish 1');
  await key('p');
  expect(dialog()?.textContent).toContain('1 German translation goes live');
  expect(dialog()?.textContent).toContain('10 · German');
  await click('Publish 1');
  // The header's button and the dialog's share a label: confirm the dialog's own.
  if (!posts().length)
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('footer button')!.click());
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toMatchObject({
    path: '/publish?contract=translation-publish-v1',
    body: {
      scope: 'translations',
      rows: [
        {
          kind: 'tooltip',
          hash: 10,
          lang: 'de',
          expected: digest('a'),
          english: digest('b'),
          before: digest('c'),
          effects: digest('d'),
        },
      ],
    },
  });
  expect(Object.keys(posts()[0]!.body as object).sort()).toEqual(['opId', 'rows', 'scope']);
  expect(row('10:de')!.textContent).toContain('Publishing…');
  expect(box('10:de').disabled).toBe(true);
});

async function confirm() {
  await act(async () => head()!.click());
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('footer button')!.click());
  await flush();
}

it('asks once more before a removal, with Cancel focused', async () => {
  await signIn(translator);
  await mount();
  await tick('30:de');
  await confirm();
  expect(posts()).toHaveLength(0);
  expect(dialog()?.querySelector('footer')?.textContent).toContain(
    'Remove Tooltip 30 in German? Players see English again.',
  );
  expect(document.activeElement?.textContent).toBe('Cancel');
  await act(async () => (document.activeElement as HTMLElement).click());
  expect(dialog()).not.toBeNull();
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('footer button')!.click());
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('footer button')!.click());
  await waitFor(() => expect(posts()).toHaveLength(1));
});

it('lists the tooltips a shared text updates, and holds back a row that changes one of them', async () => {
  const definition = { body: 'Note', revision: 'r1', ...stamp };
  bundle.globals = {
    entries: [
      {
        version: 1,
        id: 'g_refill-0001',
        kind: 'titles',
        name: 'G_refill',
        revision: 'r2',
        nameHistory: [],
        definitions: { en: definition, de: { ...definition, body: 'Notiz' } },
      },
    ],
    sync: { status: 'current', causeIds: [], lastFailure: null, causeEntries: {} },
  };
  bundle.globalsPending = [
    {
      id: 'g_refill-0001',
      kind: 'titles',
      name: 'G_refill',
      change: 'changed',
      digest: digest('9'),
      affected: [10, 40],
      languages: { de: { before: 'Alte Notiz', after: 'Notiz' } },
    },
  ];
  bundle.translationPublish!.lanes.de!.push(
    ready({ id: 'g_refill-0001' }, 'de', { affectedHashes: [10, 40] }),
  );
  await signIn(translator);
  await mount('/review?hash=g_refill-0001%3Ade');
  await waitFor(() => expect(detail()?.textContent).toContain('Updates 2 tooltips'));
  await tick('g_refill-0001:de');
  await tick('10:de');
  await tick('30:de');
  await act(async () => head()!.click());
  const listed = dialog()!.querySelector('ul[aria-label="Translations going live"]')!;
  const heldBack = dialog()!.querySelector('ul[aria-label="Not in this publish"]')!;
  expect(listed.textContent).toContain('Updates 2 tooltips');
  expect(listed.textContent).toContain('Tooltip 40');
  expect(heldBack.textContent).toContain('Tooltip 10');
  expect(heldBack.textContent).toContain('After G_refill');
});

it('shows the reason of a refused row, and sends the rest of its part by itself', async () => {
  answer = ({ opId, rows }) =>
    rows.length > 1
      ? Response.json(
          {
            error: translationPublishReasons['review-changed'],
            details: {
              rows: [{ kind: 'tooltip', hash: 10, lang: 'de', reason: 'review-changed' }],
            },
          },
          { status: 409 },
        )
      : Response.json({ opId, result: { status: 'done', rows: [] } });
  await signIn(translator);
  await mount();
  await tick('10:de');
  await tick('30:de');
  await act(async () => head()!.click());
  for (let step = 0; step < 2; step++)
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('footer button')!.click());
  await waitFor(() => expect(posts()).toHaveLength(2));
  await publishDriver.refresh();
  await waitFor(() => {
    const activity = host.querySelector('section[aria-label="Publish activity"]');
    expect(activity?.textContent).toContain('Partly live');
    expect(activity?.querySelector('[title]')?.getAttribute('title')).toContain(
      'Tooltip 10 (This translation or what it uses has changed. Review it again',
    );
  });
  expect(
    posts().map(({ body }) => (body as { rows: { hash: number }[] }).rows.map((r) => r.hash)),
  ).toEqual([[10, 30], [30]]);
  // The published row left; the refused one still waits.
  expect(rowKeys()).toEqual(['10:de', '20:de']);
});

it('drops a tick when a language is revoked, and never sends it', async () => {
  await signIn({ ...translator, languages: ['de', 'fr'] });
  await mount();
  await tick('10:de');
  await tick('40:fr');
  expect(head()!.textContent).toContain('Publish 2');
  await act(async () => head()!.click());
  await act(async () => useAuthStore.setState({ user: translator }));
  await flush();
  expect(dialog()).toBeNull();
  expect(rowKeys()).toEqual(['10:de', '20:de', '30:de']);
  expect(head()!.textContent).toContain('Publish 1');
  await confirm();
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]!.body).toMatchObject({ rows: [{ hash: 10, lang: 'de' }] });
});

it('drops a tick when the row’s English or text changes, and keeps it on reload otherwise', async () => {
  await signIn(translator);
  await mount();
  await tick('10:de');
  await tick('30:de');
  bundle.translationPublish!.lanes = lanes([
    ready({ hash: 10 }, 'de', { english: digest('1') }),
    ready({ hash: 30 }, 'de', { removed: true }),
  ]);
  await click('Refresh');
  await waitFor(() => expect(rowKeys()).toEqual(['10:de', '30:de']));
  expect(box('10:de').checked).toBe(false);
  expect(box('30:de').checked).toBe(true);
});

it('lists this tab’s newer save as blocked until the bundle has it', async () => {
  await signIn(translator);
  await mount();
  await tick('10:de');
  const next = { ...saved[10]!, text: { en, de: { text: 'Neuer', ...later } } };
  await act(async () => {
    rememberSaved([next], [], Date.now(), Date.now());
    const { data } = useDataStore.getState();
    useDataStore.setState({
      data: {
        ...data!,
        tooltipSnapshot: data!.bundle,
        bundle: { ...data!.bundle, tooltips: { ...data!.bundle.tooltips, 10: next } },
      },
    });
  });
  await flush();
  expect(head()!.disabled).toBe(true);
  expect(box('10:de').disabled).toBe(true);
  expect(box('10:de').checked).toBe(false);
  expect(row('10:de')!.title).toContain('It was saved after this list was built');
});

it('never restores an editor’s ticks, or continues its publish, for the translator it became', async () => {
  sessionStorage.setItem(
    'clarity-review-inclusions:v1',
    JSON.stringify({ account: '1', versions: [[10, 'x']] }),
  );
  await signIn(editor);
  await publishDriver
    .create([{ hash: 10, digest: digest('a'), previous: undefined }])
    .catch(() => {});
  await signIn(translator);
  calls = [];
  await mount();
  expect(useReviewQueue.getState().versions.size).toBe(0);
  expect(head()!.textContent).toBe('PublishP');
  await key('p');
  expect(dialog()).toBeNull();
  await publishDriver.refresh();
  expect(usePublishState.getState().ops).toEqual([]);
  expect(calls.filter(({ path }) => path.startsWith('/publish'))).toEqual([]);
});

it('leaves no row or tick behind at sign-out or for another account', async () => {
  await signIn(translator);
  await mount();
  await tick('10:de');
  await signIn({ ...translator, id: 2, languages: ['fr'] });
  await flush();
  expect(rowKeys()).toEqual(['40:fr']);
  expect(head()!.disabled).toBe(true);
  await signIn(null);
  await waitFor(() => expect(head()).toBeNull());
  expect(rowKeys().some((id) => id?.includes(':'))).toBe(false);
});

it.each([
  ['the Worker does not offer it', { ...translator, translationPublish: undefined }],
  ['only English is assigned', { ...translator, languages: ['en' as const] }],
])('is exactly the read-only page when %s', async (_, user) => {
  await signIn(user);
  await mount();
  expect(rowKeys()).toEqual(['10', '20', '30', '40']);
  expect(head()).toBeNull();
  expect(host.textContent).toContain('Sign in as an editor or maintainer to publish.');
  expect(host.querySelector('nav[aria-label="Workspaces"] a[href^="/review"]')).toBeNull();
});

it('has nothing to publish while the bundle lists no translations', async () => {
  delete bundle.translationPublish;
  await signIn(translator);
  await mount();
  expect(rowKeys()).toEqual([]);
  expect(host.textContent).toContain('The list of translations to publish is not ready');
  expect(head()!.disabled).toBe(true);
});

it.each(['editor', 'maintainer'] as const)(
  'folds the rows where only translations wait into one line for an %s',
  async (role) => {
    await signIn({ ...editor, role });
    await mount();
    expect(rowKeys()).toEqual(['20']);
    expect(host.querySelector('article > header p')?.textContent).toMatch(/^1 change waiting/);
    expect(host.textContent).toContain('3 translations hidden: translators publish them.');
    // The group's tick never takes them.
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[data-review-group-toggle]')!.click(),
    );
    expect(head()!.textContent).toContain('Publish 1');
    await click('Show');
    const group = buttons().find((b) => b.dataset.reviewGroup === '~translation-only')!;
    expect(group.textContent).toContain('Translations3');
    await act(async () => group.click());
    expect(rowKeys()).toEqual(['20', '10', '30', '40']);
    // Their whole publish is theirs as before.
    await tick('10');
    expect(head()!.textContent).toContain('Publish 2');
  },
);

it('folds nothing when the bundle names no such rows', async () => {
  delete bundle.translationPublish!.only;
  await signIn(editor);
  await mount();
  expect(rowKeys()).toEqual(['10', '20', '30', '40']);
  expect(host.textContent).not.toContain('translators publish');
});
