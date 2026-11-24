// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GlobalEntryWorkspace } from '../src/features/globals/GlobalEntryWorkspace';
import type { GlobalHistoryReader } from '../src/features/globals/GlobalHistory';
import type { GlobalActor, GlobalSnapshot, GlobalsService } from '../src/services/globals';
import { fixtureHead, globalFixtureSnapshot } from './globals-entries-fixture';
import { useGlobalDraftStorage } from '../src/features/globals/globalDrafts';
import { useDataStore, type EditorData } from '../src/stores/data';

let change: (value: string) => void;
vi.mock('../src/features/editor/ClarityEditor', () => ({
  ClarityEditor: (props: { onChange(value: string): void; value: string }) => {
    change = props.onChange;
    return <textarea value={props.value} readOnly />;
  },
}));

let root: Root | undefined;
let host: HTMLDivElement;
let path = '';
const stored = new Map<string, string>();
beforeEach(() => {
  useGlobalDraftStorage.setState({ failed: false });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  stored.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});
afterEach(async () => {
  useDataStore.setState({ data: null, status: 'idle' });
  vi.unstubAllGlobals();
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
});

const button = (text: string) => {
  const value = [...document.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
};
/** The header's Discard asks first, in place; this answers Discard. */
async function discard() {
  await act(async () => button('Discard').click());
  const confirm = document.querySelector('[role="group"][aria-label="Discard this draft?"]')!;
  await act(async () =>
    [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Discard')!.click(),
  );
}
function Where() {
  const location = useLocation();
  path = `${location.pathname}${location.search}`;
  return null;
}

function service(snapshot: GlobalSnapshot = globalFixtureSnapshot) {
  return {
    read: vi.fn<GlobalsService['read']>().mockResolvedValue({ kind: 'ok', value: snapshot }),
    mutate: vi.fn<GlobalsService['mutate']>(),
    retrySync: vi.fn<GlobalsService['retrySync']>(),
  };
}

async function mount(
  at: string,
  globals: GlobalsService,
  history?: GlobalHistoryReader,
  actor: GlobalActor = { role: 'maintainer', languages: [] },
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const element = () => (
    <>
      <Where />
      <GlobalEntryWorkspace service={globals} actor={actor} history={history} entryId="" />
    </>
  );
  function Routed() {
    const id = useLocation().pathname.split('/')[2] ?? '';
    return (
      <>
        <Where />
        <GlobalEntryWorkspace service={globals} actor={actor} history={history} entryId={id} />
      </>
    );
  }
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/globals" element={element()} />
          <Route path="/globals/:id" element={<Routed />} />
          <Route path="/t/:hash" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

it('opens the entry named by the stable-ID path and keeps selection in the path', async () => {
  await mount('/globals/g_title00001', service());
  expect(host.querySelector('h1')!.textContent).toBe('Reload');
  // The finder picks entries; the pane header's language select keeps the entry in the path.
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
  await act(async () => {
    select.value = 'de';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(path).toBe('/globals/g_title00001?lang=de&consumer=');
  expect(host.querySelector('h1')!.textContent).toBe('Reload');
});

it('opens an export body at hash 1 and preserves its draft through typing and discard', async () => {
  const snapshot = structuredClone(globalFixtureSnapshot);
  const entry = snapshot.entries[0];
  entry.kind = 'exports';
  entry.name = 'anti_barrier';
  entry.definitions.en!.body = 'Disrupts Barrier Champions.';
  for (const definition of Object.values(entry.definitions)) {
    definition.provenance!.hash = 1;
    definition.provenance!.path = 'tooltips/1.json';
  }
  await mount(`/globals/${entry.id}`, service(snapshot));
  expect(host.querySelector('h1')!.textContent).toBe('anti_barrier');
  expect(host.textContent).toContain('Export');
  expect(host.querySelector('textarea')!.value).toBe(entry.definitions.en!.body);
  await act(async () => change('New export body'));
  expect(host.querySelector('[aria-label="Unsaved draft"]')).not.toBeNull();
  await discard();
  expect(host.querySelector('textarea')!.value).toBe(entry.definitions.en!.body);
  await act(async () => button('Actions').click());
  await act(async () => button('Create global').click());
  expect(
    [...document.querySelectorAll('option')].some(
      (option) => option.value === 'exports' && option.textContent === 'Export',
    ),
  ).toBe(true);
  await act(async () => button('Cancel').click());
  expect(host.querySelector('textarea')!.value).toBe(entry.definitions.en!.body);
});

it('renders the definition while only the opened entry reviews wait, fail, and retry', async () => {
  const catalogue = structuredClone(globalFixtureSnapshot);
  catalogue.impacts = {};
  const globals = service(catalogue);
  let finish!: (value: unknown) => void;
  const readEntry = vi.fn().mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const lazy = { ...globals, readEntry };
  await mount('/globals/g_title00001', lazy);
  expect(host.querySelector('h1')?.textContent).toBe('Reload');
  expect(host.querySelector('textarea')?.value).toBe(catalogue.entries[1].definitions.en?.body);
  expect(host.textContent).toContain('Loading reviews…');
  expect(host.textContent).not.toContain('No affected consumers.');
  expect(readEntry).toHaveBeenCalledExactlyOnceWith('g_title00001');
  await act(async () => button('Actions').click());
  expect(document.querySelector('[role="dialog"][aria-label="Global actions"]')).not.toBeNull();
  expect(button('Rename').disabled).toBe(true);
  await act(async () => button('Actions').click());
  await act(async () => finish({ kind: 'retry', message: 'Review request failed' }));
  expect(host.textContent).toContain('Review request failed');
  readEntry.mockResolvedValueOnce({ kind: 'ok', value: globalFixtureSnapshot });
  await act(async () => button('Retry reviews').click());
  expect(host.textContent).not.toContain('Loading reviews…');
  expect(readEntry).toHaveBeenCalledTimes(2);
  await act(async () => button('Actions').click());
  expect(button('Rename').disabled).toBe(false);
});

it('reviews no tooltip impact and waits for no sync once globals fill in tooltips', async () => {
  const id = globalFixtureSnapshot.entries[0]!.id;
  const snapshot: GlobalSnapshot = {
    ...globalFixtureSnapshot,
    destinationSync: { test: { status: 'sync-pending', causeIds: [], lastFailure: null } },
  };
  const reader = () => ({
    ...service(snapshot),
    readEntry: vi.fn().mockResolvedValue({ kind: 'ok', value: snapshot }),
  });
  await mount(`/globals/${id}`, reader());
  expect(host.textContent).toContain('is paused.');
  expect(host.textContent).toContain('Needs review');
  await act(async () => root!.unmount());
  host.remove();
  useDataStore.setState({
    data: {
      items: {},
      categories: [],
      aliases: {},
      bundle: { tooltips: {}, pushed: {}, globalsPending: [] },
    } as unknown as EditorData,
    status: 'ready',
  });
  const filled = reader();
  await mount(`/globals/${id}`, filled);
  expect(filled.readEntry).toHaveBeenCalledExactlyOnceWith(id, { reviews: false });
  for (const text of ['is paused.', 'Waiting for', 'Needs review', 'Tooltip impact'])
    expect(host.textContent).not.toContain(text);
  expect(host.querySelector('[aria-label="Refresh sync"]')).toBeNull();
  expect([...host.querySelectorAll('select')].some((n) => n.textContent?.includes('acknow'))).toBe(
    false,
  );
});

it('lets a translator withdraw their own translation once globals fill in tooltips', async () => {
  const snapshot = structuredClone(globalFixtureSnapshot);
  const entry = snapshot.entries[0]!;
  entry.definitions.de = { ...entry.definitions.en! };
  useDataStore.setState({
    data: {
      items: {},
      categories: [],
      aliases: {},
      bundle: { tooltips: {}, pushed: {}, globalsPending: [] },
    } as unknown as EditorData,
    status: 'ready',
  });
  const open = async (lang: string) => {
    await mount(`/globals/${entry.id}?lang=${lang}`, service(snapshot), undefined, {
      role: 'translator',
      languages: ['de'],
    });
    const found = [...document.querySelectorAll('button')].find((n) => n.textContent === 'Actions');
    await act(async () => found?.click());
    const labels = [...document.querySelectorAll('[role="dialog"] button')].map(
      (n) => n.textContent,
    );
    await act(async () => root!.unmount());
    host.remove();
    return labels;
  };
  expect(await open('de')).toContain('Remove language');
  expect(await open('de')).not.toContain('Create global');
  expect(await open('en')).toEqual([]);
});

it('recovers reviews from a newer Worker head without replacing the draft or reloading the catalogue', async () => {
  const catalogue = structuredClone(globalFixtureSnapshot);
  catalogue.impacts = {};
  const globals = service(catalogue);
  const loaded = structuredClone(globalFixtureSnapshot);
  loaded.head = fixtureHead(7);
  const readEntry = vi
    .fn()
    .mockResolvedValueOnce({
      kind: 'conflict',
      message: 'Globals changed. Refresh to load the current snapshot.',
    })
    .mockResolvedValueOnce({ kind: 'ok', value: loaded });
  await mount('/globals/g_damage0001', { ...globals, readEntry });
  await act(async () => change('KEPT DRAFT'));
  expect(host.textContent).toContain('Globals changed.');
  await act(async () => button('Retry reviews').click());
  expect(globals.read).toHaveBeenCalledTimes(1);
  expect(readEntry).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('Globals changed.');
  expect(host.querySelectorAll('[data-global-consumer]').length).toBe(2);
  expect(host.querySelector('textarea')!.value).toBe('KEPT DRAFT');
});

it('keeps a confirmed rename through follow-up sync refresh and repeated review failures', async () => {
  const queued = structuredClone(globalFixtureSnapshot);
  const id = queued.entries[0].id;
  queued.renameIntents = {
    [id]: { intentId: 'intent1', renameCompleted: false, name: 'Harm', status: 'queued' },
  };
  const applied = structuredClone(queued);
  applied.entries[0].name = 'Harm';
  applied.head = fixtureHead(7);
  applied.renameIntents = {};
  applied.impacts = {};
  const synced = structuredClone(applied);
  synced.head = fixtureHead(8);
  applied.sync[id] = { status: 'sync-pending', causeIds: ['other'] };
  const globals = service(globalFixtureSnapshot);
  globals.read.mockResolvedValueOnce({ kind: 'ok', value: queued });
  const readEntry = vi
    .fn<NonNullable<GlobalsService['readEntry']>>()
    .mockResolvedValueOnce({ kind: 'ok', value: applied })
    .mockResolvedValueOnce({ kind: 'ok', value: { ...applied, impacts: { [id]: [] } } })
    .mockResolvedValueOnce({ kind: 'ok', value: synced })
    .mockResolvedValue({ kind: 'retry', message: 'Invalid global review page' });
  await mount(`/globals/${id}`, { ...globals, readEntry });
  expect(host.textContent).toContain('Rename queued.');
  await act(async () => button('Refresh').click());
  expect(readEntry.mock.calls).toEqual([[id, { reviews: false }], [id]]);
  expect(host.querySelector('h1')?.textContent).toBe('Harm');
  expect(host.textContent).not.toContain('Rename queued.');
  await act(async () => button('Refresh').click());
  expect(readEntry.mock.calls.slice(2)).toEqual([[id, { reviews: false }], [id]]);
  expect(host.querySelector('h1')?.textContent).toBe('Harm');
  expect(host.textContent).toContain('Invalid global review page');
  await act(async () => button('Retry reviews').click());
  expect(readEntry).toHaveBeenCalledTimes(5);
  expect(globals.read).toHaveBeenCalledTimes(1);
  expect(host.querySelector('h1')?.textContent).toBe('Harm');
  expect(host.textContent).toContain('Invalid global review page');
  expect(host.textContent).not.toContain('Acknowledge review');
});

it('keeps an unsaved definition across a remount (reload) and marks it stale after a new revision', async () => {
  await mount('/globals/g_damage0001', service());
  await act(async () => change('LOCAL 20%'));
  expect(host.querySelector('[aria-label="Unsaved draft"]')).not.toBeNull();
  await act(async () => root!.unmount());
  host.remove();
  await mount('/globals/g_damage0001', service());
  expect(host.querySelector('textarea')!.value).toBe('LOCAL 20%');
  expect(host.querySelector('[aria-label="Unsaved draft"]')).not.toBeNull();
  expect(button('Save').disabled).toBe(false);

  await act(async () => root!.unmount());
  host.remove();
  const moved = structuredClone(globalFixtureSnapshot);
  moved.head = fixtureHead(9);
  moved.entries[0].revision = 'r2';
  await mount('/globals/g_damage0001', service(moved));
  expect(host.querySelector('textarea')!.value).toBe('LOCAL 20%');
  expect(host.textContent).toContain('saved revision changed');
  expect(button('Save').disabled).toBe(true);
  await discard();
  expect(host.querySelector('textarea')!.value).toBe('15%');
  expect(stored.size).toBe(0);
});

it('typing back to the saved text leaves no stored draft', async () => {
  await mount('/globals/g_damage0001', service());
  await act(async () => change('20%'));
  expect(stored.size).toBe(1);
  await act(async () => change('15%'));
  expect(stored.size).toBe(0);
  expect(host.querySelector('[aria-label="Unsaved draft"]')).toBeNull();
});

it('keeps edits in memory and warns when device draft storage fails, then clears the warning on recovery', async () => {
  await mount('/globals/g_damage0001', service());
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Quota exceeded');
  });
  await act(async () => change('20%'));
  expect(host.querySelector('textarea')!.value).toBe('20%');
  expect(useGlobalDraftStorage.getState().failed).toBe(true);
  expect(button('Save').disabled).toBe(false);
  write.mockRestore();
  await act(async () => change('25%'));
  expect(useGlobalDraftStorage.getState().failed).toBe(false);
  expect(stored.size).toBe(1);
  const failAgain = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Quota exceeded');
  });
  await act(async () => change('30%'));
  expect(useGlobalDraftStorage.getState().failed).toBe(true);
  await act(async () => root!.unmount());
  root = undefined;
  expect(useGlobalDraftStorage.getState().failed).toBe(false);
  failAgain.mockRestore();
});

it('restores an older version into the draft; saving stays an ordinary edit', async () => {
  const older = structuredClone(globalFixtureSnapshot.entries[0]);
  older.definitions.en!.body = '10%';
  const reader = {
    history: vi.fn<GlobalHistoryReader['history']>().mockResolvedValue({
      kind: 'ok',
      value: {
        head: fixtureHead(1),
        page: 1,
        commits: [
          {
            commit: 'c'.repeat(40),
            author: 'Someone',
            login: 'someone',
            avatar: null,
            date: '2026-01-01T00:00:00Z',
            message: 'Save global entry with Sync pending cause',
          },
        ],
      },
    }),
    historyVersion: vi.fn<GlobalHistoryReader['historyVersion']>().mockResolvedValue({
      kind: 'ok',
      value: { head: fixtureHead(1), commit: 'c'.repeat(40), entry: older },
    }),
  };
  const globals = service();
  await mount('/globals/g_damage0001?tab=history', globals, reader);
  expect(reader.history).toHaveBeenCalledWith('g_damage0001', 1);
  expect(host.textContent).toContain('Save global entry with Sync pending cause, someone');
  expect(host.textContent).not.toContain('Older versions');
  // The preview column has its own (disabled) Compare view; this is the history entry's.
  const compare = [
    ...document.querySelectorAll('[aria-label="Global usages and translations"] button'),
  ].find((node) => node.textContent === 'Compare') as HTMLButtonElement;
  await act(async () => compare.click());
  expect(reader.historyVersion).toHaveBeenCalledWith('g_damage0001', 'c'.repeat(40));
  await act(async () => button('Restore into draft').click());
  expect(host.querySelector('textarea')!.value).toBe('10%');
  expect(host.querySelector('[aria-label="Unsaved draft"]')).not.toBeNull();
  expect(globals.mutate).not.toHaveBeenCalled();
});

it('shows saved impact, not a projection panel, while a draft is open', async () => {
  await mount('/globals/g_damage0001', service());
  await act(async () => change('20%'));
  expect(host.textContent).not.toContain('Calculate projected impact');
  expect(host.querySelector('[aria-label="Global pane"] [aria-selected="true"]')!.textContent).toBe(
    'Usages',
  );
  expect(host.querySelectorAll('[data-global-consumer]').length).toBe(2);
});

it('lists the tooltips an unedited global is used by, once per alias group, and opens them', async () => {
  const text = (hash: number, value: string) => ({
    hash,
    text: { en: { text: value } },
    associated: [],
  });
  const item = (hash: number, name: string) => ({ hash, name, icon: '', categoryId: 'perk' });
  useDataStore.setState({
    status: 'ready',
    data: {
      categories: [],
      items: {
        30: item(30, 'Rampage'),
        31: item(31, 'Rampage copy'),
        32: item(32, 'Outlaw'),
        34: item(34, 'Kill Clip'),
      },
      aliases: { 31: { to: 30, kind: 'sandbox' } },
      bundle: {
        tooltips: {
          2: text(2, 'var Damage = 10%'),
          30: text(30, 'Deals #Damage more.'),
          32: text(32, 'Reloads #{Damage}x faster.'),
          34: text(34, 'Intro\nimport main from 31'),
        },
      },
    } as unknown as EditorData,
  });
  const catalogue = structuredClone(globalFixtureSnapshot);
  catalogue.impacts = { g_damage0001: [], g_title00001: [] };
  await mount('/globals/g_damage0001', service(catalogue));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  // One Usages place: the pane tab carries the count; the left column has no Usages row.
  expect(host.querySelector('[aria-label="Show usages"]')).toBeNull();
  expect(host.textContent).not.toContain('Usages:');
  const tab = host.querySelector('[aria-label="Global pane"] [aria-selected="true"]')!;
  expect(tab.textContent).toBe('Usages 3');
  const rows = [...host.querySelectorAll('[data-global-usage]')];
  expect(rows.map((row) => row.textContent)).toEqual([
    'Kill ClipOther: perk · English · Through import main from Rampage copy',
    'OutlawOther: perk · English · Direct',
    'RampageOther: perk · English · Direct · 2 items',
  ]);
  // Enter (a link's activation) opens the tooltip in the editor.
  const link = rows[2].querySelector('a')!;
  expect(link.getAttribute('href')).toBe('/t/30?lang=en&variant=30&line=1');
  await act(async () => link.click());
  expect(path).toBe('/t/30?lang=en&variant=30&line=1');
});

it('says when a global is not used by any tooltip', async () => {
  useDataStore.setState({
    status: 'ready',
    data: {
      categories: [],
      items: {},
      aliases: {},
      bundle: { tooltips: { 2: { hash: 2, text: { en: { text: '' } }, associated: [] } } },
    } as unknown as EditorData,
  });
  const catalogue = structuredClone(globalFixtureSnapshot);
  catalogue.impacts = { g_damage0001: [], g_title00001: [] };
  await mount('/globals/g_title00001', service(catalogue));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(host.textContent).toContain('Not used by any tooltip.');
});

it('filters the saved impacts under a row, and the selection, by language', async () => {
  const catalogue = structuredClone(globalFixtureSnapshot);
  const english = catalogue.impacts.g_damage0001[0];
  const french = structuredClone(english);
  french.id = 'review_10_fr_live';
  french.consumer = { ...french.consumer, lang: 'fr' };
  french.review = { ...french.review, consumer: french.consumer };
  catalogue.impacts = { g_damage0001: [english, french], g_title00001: [] };
  await mount('/globals/g_damage0001?usageLang=fr', service(catalogue));
  // One tooltip row; only its French obligation shows and is selected for the comparison.
  expect(host.querySelectorAll('[data-global-usage]').length).toBe(1);
  expect(
    [...host.querySelectorAll('[data-global-consumer]')].map((row) =>
      row.getAttribute('data-global-consumer'),
    ),
  ).toEqual(['review_10_fr_live']);
  expect(host.textContent).toContain('Focused Fury (French)');
  expect(host.textContent).not.toContain('Focused Fury (English)');
});
