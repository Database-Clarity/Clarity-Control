// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GlobalEntryWorkspace } from '../src/features/globals/GlobalEntryWorkspace';
import type { GlobalHistoryReader } from '../src/features/globals/GlobalHistory';
import type { GlobalSnapshot, GlobalsService } from '../src/services/globals';
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

async function mount(at: string, globals: GlobalsService, history?: GlobalHistoryReader) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const element = () => (
    <>
      <Where />
      <GlobalEntryWorkspace
        service={globals}
        actor={{ role: 'maintainer', languages: [] }}
        history={history}
        entryId=""
      />
    </>
  );
  function Routed() {
    const id = useLocation().pathname.split('/')[2] ?? '';
    return (
      <>
        <Where />
        <GlobalEntryWorkspace
          service={globals}
          actor={{ role: 'maintainer', languages: [] }}
          history={history}
          entryId={id}
        />
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
  await act(async () => button('Discard').click());
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
  await act(async () => finish({ kind: 'retry', message: 'Review request failed' }));
  expect(host.textContent).toContain('Review request failed');
  readEntry.mockResolvedValueOnce({ kind: 'ok', value: globalFixtureSnapshot });
  await act(async () => button('Retry reviews').click());
  expect(host.textContent).not.toContain('Loading reviews…');
  expect(readEntry).toHaveBeenCalledTimes(2);
});

it('recovers reviews after the head moved past the catalogue: Retry reads a fresh snapshot', async () => {
  const catalogue = structuredClone(globalFixtureSnapshot);
  catalogue.impacts = {};
  const moved = structuredClone(catalogue);
  moved.head = fixtureHead(7);
  const globals = service(catalogue);
  globals.read.mockResolvedValueOnce({ kind: 'ok', value: catalogue });
  globals.read.mockResolvedValueOnce({ kind: 'ok', value: moved });
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
  expect(globals.read).toHaveBeenCalledTimes(2);
  expect(readEntry).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('Globals changed.');
  expect(host.querySelectorAll('[data-global-consumer]').length).toBe(2);
  expect(host.querySelector('textarea')!.value).toBe('KEPT DRAFT');
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
  await act(async () => button('Discard').click());
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
      items: { 30: item(30, 'Rampage'), 31: item(31, 'Rampage copy'), 32: item(32, 'Outlaw') },
      aliases: { 31: { to: 30, kind: 'sandbox' } },
      bundle: {
        tooltips: {
          2: text(2, 'var Damage = 10%'),
          30: text(30, 'Deals #Damage more.'),
          32: text(32, 'Reloads #{Damage}x faster.'),
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
  expect(tab.textContent).toBe('Usages 2');
  const rows = [...host.querySelectorAll('[data-global-usage]')];
  expect(rows.map((row) => row.textContent)).toEqual([
    'OutlawOther: perk · English · Direct',
    'RampageOther: perk · English · Direct · 2 items',
  ]);
  // Enter (a link's activation) opens the tooltip in the editor.
  const link = rows[1].querySelector('a')!;
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
