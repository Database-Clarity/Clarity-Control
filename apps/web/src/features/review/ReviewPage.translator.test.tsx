// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  publishableHash,
  translationBeforeDigest,
  translationEnglishDigest,
  translationExpectedDigest,
  translationPublishReasons,
  type Tooltip,
} from '@clarity/core';
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
import { prepareReviewQueue } from './model';
import { publishedOf } from './globalRows';
import { laneEntries } from './lanes';
import { loadPublished, publishedRows, resetPublished, usePublished } from './published';
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
    ...('hash' in id ? facts[`${id.hash}:${lang}`] : undefined),
    effects: digest('d'),
    removed: false,
    englishFallback: false,
    affectedHashes: [],
    ...extra,
  }) as ReadyTranslation;

/** The live facts a row is prepared from, by row; filled in before each test. */
let facts: Record<string, Pick<ReadyTranslation, 'expected' | 'english' | 'before'>> = {};
async function liveFacts() {
  const rows = await Promise.all(
    Object.values(live).flatMap((entry) =>
      (['de', 'fr'] as const).map(
        async (lang) =>
          [
            `${entry.hash}:${lang}`,
            {
              expected: await translationExpectedDigest(saved[entry.hash]!.text[lang]),
              english: await translationEnglishDigest(entry.text.en!),
              before: await translationBeforeDigest(entry.text[lang]),
            },
          ] as const,
      ),
    ),
  );
  return Object.fromEntries(rows);
}

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
/** What History answers, and when. */
let served: (hash: number) => Tooltip | undefined;
let historyGate: (hash: number) => Promise<void> | void;

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
  if (user)
    await publishDriver.start(
      String(user.id),
      user.role === 'translator' ? user.languages : undefined,
    );
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
  facts = await liveFacts();
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
  served = (hash) => live[hash];
  historyGate = () => undefined;
  answer = ({ opId }) => Response.json({ opId, status: 'pending' }, { status: 202 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('https://synthetic.invalid', '');
      const version = /^\/history\/(\d+)\?live=1/.exec(path);
      if (version) {
        await historyGate(Number(version[1]));
        return Response.json({
          tooltip: served(Number(version[1])) ?? null,
          pushedHash: bundle.pushed[version[1]!] ?? null,
        });
      }
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
  expect(row('10:de')!.textContent).not.toContain('German');
  expect(detail()?.querySelector('del')?.textContent).toContain('Alt');
});

it('compares with the published text beside live English, not with an English change that waits', async () => {
  await signIn(translator);
  await mount('/review?hash=30%3Ade');
  await waitFor(() =>
    expect(detail()?.textContent).toContain('Removes the German translation. Players see English'),
  );
  // Both sides players see: the German that goes, and the live English that comes back.
  const removed = detail()!.querySelector('section[aria-label="German comparison"]')!;
  await waitFor(() => expect(removed.querySelector('del')?.textContent).toContain('Alt'));
  expect(removed.querySelector('ins')?.textContent).toContain('English');
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
  await openConfirm();
  expect(dialog()?.textContent).toContain('1 French translation goes live');
  expect(dialog()?.textContent).toContain('40 · French');
});

it('sends exactly the reviewed facts of the confirmed rows, once', async () => {
  await signIn(translator);
  await mount();
  await tick('10:de');
  expect(head()!.textContent).toContain('Publish 1');
  await waitFor(() => expect(usePublished.getState().byHash[10]?.status).toBe('ready'));
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
          ...facts['10:de'],
          effects: digest('d'),
        },
      ],
    },
  });
  expect(Object.keys(posts()[0]!.body as object).sort()).toEqual(['opId', 'rows', 'scope']);
  expect(row('10:de')!.textContent).toContain('Publishing…');
  expect(box('10:de').disabled).toBe(true);
});

/** Publish waits for the comparisons it confirms; the confirmation opens once they are shown. */
async function openConfirm() {
  await waitFor(() => {
    const byHash = usePublished.getState().byHash;
    const { entries, versions } = useReviewQueue.getState();
    for (const { lane } of entries ?? [])
      if (lane?.hash !== undefined && versions.has(lane.key))
        expect(byHash[lane.hash]?.status).toBe('ready');
  });
  await act(async () => head()!.click());
  expect(dialog()).not.toBeNull();
}

async function confirm() {
  await openConfirm();
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
  await openConfirm();
  const listed = dialog()!.querySelector('ul[aria-label="Translations going live"]')!;
  const heldBack = dialog()!.querySelector('ul[aria-label="Not in this publish"]')!;
  expect(listed.textContent).toContain('Updates 2 tooltips');
  expect(listed.textContent).toContain('Tooltip 40');
  expect(heldBack.textContent).toContain('Tooltip 10');
  expect(heldBack.textContent).toContain('After G_refill');
});

it('counts an alias copy as its original, never as another tooltip', async () => {
  vi.mocked(loadGenerator).mockResolvedValue({
    ...(await loadGenerator()),
    aliases: { 50: { to: 10, kind: 'sandbox' }, 60: { to: 40, kind: 'sandbox' } },
  });
  bundle.translationPublish!.lanes = lanes([
    ready({ hash: 10 }, 'de', { affectedHashes: [40, 50, 60] }),
  ]);
  await signIn(translator);
  await mount();
  await waitFor(() => expect(detail()?.textContent).toContain('Also updates 1 tooltip'));
  expect(detail()?.querySelector('details')?.textContent).toContain('Tooltip 40');
  expect(detail()?.querySelector('details')?.textContent).not.toContain('Tooltip 50');
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
  await openConfirm();
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
  await openConfirm();
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
  // Only the account's own publish index is read (for a late failure it may still have).
  expect(
    calls.filter(({ path }) => path.startsWith('/publish') && path !== '/publish/mine'),
  ).toEqual([]);
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
  ['the last language is removed', []],
  ['only English is assigned', ['en' as const]],
])('stays a translator’s own page when %s', async (_, languages) => {
  await signIn(translator);
  await mount();
  await waitFor(() => expect(usePublished.getState().byHash[10]?.status).toBe('ready'));
  await tick('10:de');
  const asked = () =>
    vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('live=1')).length;
  const before = asked();
  await signIn({ ...translator, languages });
  await flush();
  expect(rowKeys()).toEqual([]);
  expect(host.textContent).toContain('Nothing is waiting to go live.');
  expect(host.textContent).not.toContain('Sign in as an editor or maintainer to publish.');
  expect(head()!.disabled).toBe(true);
  expect(useReviewQueue.getState().versions.size).toBe(0);
  expect(asked()).toBe(before);
});

it('is exactly the read-only page when the Worker does not offer it', async () => {
  await signIn({ ...translator, translationPublish: undefined });
  await mount();
  expect(rowKeys()).toEqual(['10', '20', '30', '40']);
  expect(head()).toBeNull();
  expect(host.textContent).toContain('Sign in as an editor or maintainer to publish.');
  expect(host.querySelector('nav[aria-label="Workspaces"] a[href^="/review"]')).toBeNull();
});

it('keeps the entry, the page, and every tick while a bundle comes without its translations', async () => {
  answer = ({ opId }) => Response.json({ opId, result: { status: 'done', rows: [] } });
  await signIn(translator);
  await mount();
  await tick('30:de');
  await openConfirm();
  for (let step = 0; step < 2; step++)
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('footer button')!.click());
  await waitFor(() => expect(rowKeys()).toEqual(['10:de', '20:de']));
  await tick('10:de');
  const complete = bundle.translationPublish!;
  delete bundle.translationPublish;
  await click('Refresh');
  await waitFor(() => expect(host.textContent).toContain('Checking published text…'));
  expect(rowKeys()).toEqual([]);
  expect(head()!.disabled).toBe(true);
  await key('p');
  expect(dialog()).toBeNull();
  expect(host.querySelector('nav[aria-label="Workspaces"] a[href^="/review"]')?.textContent).toBe(
    'Review changes',
  );
  expect([...useReviewQueue.getState().versions.keys()]).toEqual(['10:de']);
  expect(sessionStorage.getItem('clarity-review-inclusions:v1')).toContain('10:de');
  // The next complete bundle is picked up: same version, same tick; the published row stays away.
  bundle.translationPublish = complete;
  await click('Refresh');
  await waitFor(() => expect(rowKeys()).toEqual(['10:de', '20:de']));
  expect(box('10:de').checked).toBe(true);
  // Only a changed version drops it.
  delete bundle.translationPublish;
  await click('Refresh');
  await waitFor(() => expect(rowKeys()).toEqual([]));
  bundle.translationPublish = {
    ...complete,
    lanes: lanes([ready({ hash: 10 }, 'de', { effects: digest('2') })]),
  };
  await click('Refresh');
  await waitFor(() => expect(rowKeys()).toEqual(['10:de']));
  expect(box('10:de').checked).toBe(false);
});

it('asks for the next bundle by itself while the translations are missing', async () => {
  await signIn(translator);
  await mount();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    delete bundle.translationPublish;
    await click('Refresh');
    expect(host.textContent).toContain('Checking published text…');
    const loads = vi.mocked(loadBundle).mock.calls.length;
    await act(async () => vi.advanceTimersByTime(30_000));
    await flush();
    expect(vi.mocked(loadBundle).mock.calls.length).toBe(loads + 1);
  } finally {
    vi.useRealTimers();
  }
});

it('shows a new translation against the English players see now', async () => {
  const none = { ...live[40]!, text: { en } };
  served = (hash) => (hash === 40 ? none : live[hash]);
  bundle.translationPublish!.lanes = lanes([
    ready({ hash: 40 }, 'fr', { before: await translationBeforeDigest(undefined) }),
  ]);
  await signIn({ ...translator, languages: ['fr'] });
  await mount();
  await waitFor(() => expect(detail()?.textContent).toContain('New French translation.'));
  await waitFor(() => expect(detail()?.querySelector('del')?.textContent).toContain('English'));
  expect(detail()?.querySelector('ins')?.textContent).toContain('Nouveau');
});

it('never shows or confirms another live version than the signed one', async () => {
  // The same marker, another stamp: History answers with the newest version.
  const newer = {
    ...live[10]!,
    text: { en, de: { ...live[10]!.text.de!, updatedBy: 'someone' } },
  };
  served = (hash) => (hash === 10 ? newer : live[hash]);
  bundle.translationPublish!.lanes = lanes([
    ready({ hash: 10 }, 'de', { snapshot: 'a'.repeat(40) }),
    ready({ hash: 30 }, 'de', { removed: true }),
  ]);
  await signIn(translator);
  await mount();
  await waitFor(() =>
    expect(detail()?.textContent).toContain('Changed after this list was built.'),
  );
  await tick('10:de');
  await act(async () => head()!.click());
  expect(dialog()).toBeNull();
  expect(host.textContent).toContain(
    'Some of these changed after this list was built. Refresh to review them.',
  );
  // Nothing of it is kept under the signed version: the right one is asked for again.
  served = (hash) => live[hash];
  await click('Refresh');
  await waitFor(() => expect(detail()?.textContent).toContain('Text changed in German'));
  await openConfirm();
  expect(dialog()).not.toBeNull();
});

it('checks every language’s signed facts, also after a filtered page checked one', async () => {
  // French was published again under the same marker: German's facts still hold, French's do not.
  const both = { text: { en, de: { text: 'Alt', ...later }, fr: { text: 'Vieux', ...later } } };
  const signed = { ...live[10]!, ...both };
  const newer = {
    ...signed,
    text: { ...signed.text, fr: { ...signed.text.fr, updatedBy: 'someone' } },
  };
  served = (hash) => (hash === 10 ? newer : live[hash]);
  bundle.tooltips[10] = {
    ...signed,
    text: { ...signed.text, de: { text: 'Neu', ...later }, fr: { text: 'Nouveau', ...later } },
  };
  const row10 = async (lang: 'de' | 'fr') =>
    ready({ hash: 10 }, lang, {
      snapshot: 'a'.repeat(40),
      before: await translationBeforeDigest(signed.text[lang]),
    });
  bundle.translationPublish!.lanes = lanes([await row10('de'), await row10('fr')]);
  await signIn({ ...translator, languages: ['de', 'fr'] });
  await useDataStore.getState().load();
  // The route of a page filtered to German checks German alone.
  const german = laneEntries(useDataStore.getState().data!, ['de'], new Set());
  await loadPublished(publishedRows(german));
  await vi.waitFor(() => expect(usePublished.getState().byHash[10]?.status).toBe('ready'));
  await mount('/review?lang=de');
  await waitFor(() => expect(usePublished.getState().byHash[10]?.status).toBe('changed'));
  await tick('10:de');
  await act(async () => useReviewQueue.getState().includeAll([]));
  const french = useReviewQueue.getState().entries!.find(({ lane }) => lane?.lang === 'fr')!;
  await act(async () => useReviewQueue.getState().decide(french));
  await act(async () => head()!.click());
  expect(dialog()).toBeNull();
  expect(host.textContent).toContain('Some of these changed after this list was built.');
});

it('a Retry of one language leaves no other language unchecked', async () => {
  const signed = {
    ...live[10]!,
    text: { en, de: { text: 'Alt', ...later }, fr: { text: 'Vieux', ...later } },
  };
  const newer = {
    ...signed,
    text: { ...signed.text, fr: { ...signed.text.fr, updatedBy: 'someone' } },
  };
  served = (hash) => (hash === 10 ? newer : live[hash]);
  bundle.tooltips[10] = {
    ...signed,
    text: { ...signed.text, de: { text: 'Neu', ...later }, fr: { text: 'Nouveau', ...later } },
  };
  const row10 = async (lang: 'de' | 'fr') =>
    ready({ hash: 10 }, lang, {
      snapshot: 'a'.repeat(40),
      before: await translationBeforeDigest(signed.text[lang]),
    });
  bundle.translationPublish!.lanes = lanes([await row10('de'), await row10('fr')]);
  // The first answer fails; only then does the open German row ask again.
  historyGate = (hash) => {
    if (hash === 10) throw new Error('offline');
  };
  await signIn({ ...translator, languages: ['de', 'fr'] });
  await mount('/review?hash=10%3Ade');
  await waitFor(() => expect(detail()?.textContent).toContain('load the published version'));
  historyGate = () => undefined;
  await click('Retry');
  await waitFor(() => expect(usePublished.getState().byHash[10]?.status).not.toBe('loading'));
  const french = useReviewQueue.getState().entries!.find(({ lane }) => lane?.lang === 'fr')!;
  await act(async () => useReviewQueue.getState().decide(french));
  await act(async () => head()!.click());
  expect(dialog()).toBeNull();
  // Even a version checked for German alone never stands for French.
  const german = laneEntries(useDataStore.getState().data!, ['de', 'fr'], new Set()).filter(
    ({ lane }) => lane.lang === 'de',
  );
  resetPublished();
  await act(async () => loadPublished(publishedRows(german)));
  await waitFor(() => expect(usePublished.getState().byHash[10]?.status).toBe('ready'));
  expect(publishedOf(french, usePublished.getState().byHash)?.status).toBe('loading');
});

it('writes the ticks a cold tab drops for a lost language', async () => {
  const picks = [
    ['10:de', 'a'],
    ['40:fr', 'b'],
  ];
  sessionStorage.setItem(
    'clarity-review-inclusions:v1',
    JSON.stringify({ account: '1/translations', versions: picks }),
  );
  useAuthStore.setState({ user: translator, loading: false, load: async () => {} });
  vi.resetModules();
  // A fresh store, as after a reload, with the account already settled.
  const { useReviewQueue: cold } = await import('./queueStore');
  const { useAuthStore: auth } = await import('../../stores/auth');
  auth.setState({ user: translator, loading: false });
  expect([...cold.getState().versions.keys()]).toEqual(['10:de']);
  expect(sessionStorage.getItem('clarity-review-inclusions:v1')).not.toContain('40:fr');
  expect(sessionStorage.getItem('clarity-review-inclusions:v1')).toContain('10:de');
});

it('waits for the comparison before it can be confirmed', async () => {
  let release = () => {};
  historyGate = (hash) => (hash === 10 ? new Promise((done) => (release = done)) : undefined);
  await signIn(translator);
  await mount();
  await tick('10:de');
  await act(async () => head()!.click());
  expect(dialog()).toBeNull();
  expect(host.textContent).toContain('Wait for the published versions to load');
  release();
  await waitFor(() => expect(detail()?.textContent).toContain('Text changed in German'));
  await openConfirm();
  expect(dialog()).not.toBeNull();
});

it('keeps an assigned language without rows selected, until the filters are cleared', async () => {
  bundle.translationPublish!.lanes = lanes([ready({ hash: 10 }, 'de')]);
  await signIn({ ...translator, languages: ['de', 'fr'] });
  await mount();
  const select = () => host.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
  await act(async () => {
    select().value = 'fr';
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
  expect(select().value).toBe('fr');
  expect(rowKeys()).toEqual([]);
  await click('Refresh');
  expect(select().value).toBe('fr');
  const clear = [...host.querySelectorAll('article button')].find(
    (b) => b.textContent === 'Clear filters',
  ) as HTMLButtonElement;
  await act(async () => clear.click());
  await flush();
  expect(rowKeys()).toEqual(['10:de']);
  // A language that is not assigned never filters.
  await signIn(translator);
  expect(rowKeys()).toEqual(['10:de']);
});

it('a late editor preparation never reaches the list of the translator it became', async () => {
  await signIn(editor);
  await mount();
  await waitFor(() => expect(rowKeys()).toEqual(['20']));
  const data = structuredClone(useDataStore.getState().data!);
  useDataStore.setState({ data });
  const late = prepareReviewQueue(data);
  await signIn(translator);
  await act(async () => late);
  await flush();
  expect(rowKeys()).toEqual(['10:de', '20:de', '30:de']);
  expect(useReviewQueue.getState().entries!.every(({ lane }) => lane?.lang === 'de')).toBe(true);
});

it('drops the ticks of a lost language at once, even while the list is missing', async () => {
  await signIn({ ...translator, languages: ['de', 'fr'] });
  await mount();
  await tick('10:de');
  await tick('40:fr');
  delete bundle.translationPublish;
  await click('Refresh');
  await waitFor(() => expect(rowKeys()).toEqual([]));
  await signIn(translator);
  expect([...useReviewQueue.getState().versions.keys()]).toEqual(['10:de']);
  expect(sessionStorage.getItem('clarity-review-inclusions:v1')).not.toContain('40:fr');
  await signIn({ ...translator, languages: ['de', 'fr'] });
  expect([...useReviewQueue.getState().versions.keys()]).toEqual(['10:de']);
});

it('sends nothing while another sign-in is settling', async () => {
  await signIn(translator);
  await mount();
  await waitFor(() => expect(detail()?.textContent).toContain('Text changed in German'));
  await tick('10:de');
  await act(async () => useAuthStore.setState({ loading: true }));
  await confirm();
  await publishDriver.refresh();
  expect(posts()).toEqual([]);
  // Another account's token in this browser: still nothing.
  await act(async () => useAuthStore.setState({ loading: false, token: 'other' }));
  await publishDriver.refresh();
  expect(posts()).toEqual([]);
  expect(usePublishState.getState().ops).toHaveLength(1);
});

it('folds a translation on a migration leftover, and lists it while anything else waits too', async () => {
  // Current has aliases that the live marker of 10 and 40 does not name yet.
  vi.mocked(loadGenerator).mockResolvedValue({
    ...(await loadGenerator()),
    aliases: { 11: { to: 10, kind: 'frame' }, 41: { to: 40, kind: 'frame' } },
  });
  bundle.translationPublish!.only = { tooltips: [30], globals: [] };
  bundle.tooltips[40] = { ...saved[40]!, associated: [10] };
  let release = () => {};
  historyGate = (hash) => (hash === 10 ? new Promise((done) => (release = done)) : undefined);
  await signIn(editor);
  await mount();
  // Nothing leaves the list before it is proved, and one slow answer holds up no other row.
  expect(rowKeys()).toEqual(['10', '20', '40']);
  await waitFor(() => expect(usePublished.getState().byHash[40]?.status).toBe('ready'));
  expect(rowKeys()).toEqual(['10', '20', '40']);
  release();
  // 40 also has an association: it stays.
  await waitFor(() => expect(rowKeys()).toEqual(['20', '40']));
  expect(host.textContent).toContain('2 translations hidden: translators publish them.');
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
