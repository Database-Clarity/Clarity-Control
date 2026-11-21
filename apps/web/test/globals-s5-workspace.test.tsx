// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { GlobalEntryWorkspace } from '../src/features/globals/GlobalEntryWorkspace';
import type { GlobalHistoryReader } from '../src/features/globals/GlobalHistory';
import { globalUsagesUrl } from '../src/features/globals/usageArtifact';
import { globalUsageStampInputs } from '../src/features/globals/usageStamp';
import { bundleGlobalUsages } from '../src/features/globals/usages';
import type { GlobalSnapshot, GlobalsService } from '../src/services/globals';
import { fixtureHead, globalFixtureSnapshot } from './globals-entries-fixture';
import { useGlobalDraftStorage } from '../src/features/globals/globalDrafts';
import { useDataStore, type EditorData } from '../src/stores/data';
import { clearSavedOverlay } from '../src/stores/savedOverlay';
import { applyHeadToData } from '../src/stores/conflicts';
import { acceptSaved } from '../src/services/save/drafts';

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
let navigate: NavigateFunction;
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
  clearSavedOverlay();
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
  navigate = useNavigate();
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

it.each([true, false])(
  'keeps viewed usages current across saves and refresh (artifact %s)',
  async (withArtifact) => {
    const snapshot = structuredClone(globalFixtureSnapshot);
    const [damage, title] = snapshot.entries;
    snapshot.impacts = { [damage.id]: [], [title.id]: [] };
    const empty = { globals: [], tooltips: [] };
    const data = {
      items: {},
      categories: [],
      aliases: {},
      bundle: {
        sourceCommit: snapshot.head,
        generatedAt: '2026-01-01T00:00:00Z',
        tooltips: {
          30: { hash: 30, text: { en: { text: '#Damage' } }, associated: [] },
          31: {
            hash: 31,
            text: { en: { text: '<title Reload [Reload] />' } },
            associated: [],
          },
        },
        globals: {
          entries: snapshot.entries,
        },
      },
    } as unknown as EditorData;
    const publish = (
      value: EditorData,
      rows = bundleGlobalUsages(value, value.bundle.globals!.entries),
    ) => {
      value.bundledUsageInputs = {
        bundle: value.bundle,
        aliases: value.aliases,
        items: value.items,
      };
      const { items, aliases } = globalUsageStampInputs(value.items, value.aliases, undefined);
      const digest = (text: string) => createHash('sha256').update(text).digest('hex');
      return {
        stamp: {
          version: 1,
          sourceCommit: value.bundle.sourceCommit,
          itemsHash: digest(items),
          aliasesHash: digest(aliases),
        },
        usages: rows,
      };
    };
    let artifact = publish(data);
    vi.stubGlobal('crypto', webcrypto);
    const fetchArtifact = vi.fn(async (url: string) => {
      expect(url).toBe(globalUsagesUrl);
      return withArtifact ? Response.json(artifact) : new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchArtifact);
    useDataStore.setState({ status: 'ready', data });
    const globals = service(snapshot);
    const href = () => host.querySelector('[data-global-usage] a')?.getAttribute('href');
    await mount(`/globals/${damage.id}`, globals);
    const expectHref = (expected: string | undefined) =>
      vi.waitFor(async () => {
        await act(async () => {});
        expect(href()).toBe(expected);
      });
    await expectHref('/t/30?lang=en&variant=30&line=1');
    expect(fetchArtifact).toHaveBeenCalledTimes(1);

    // A: add and remove a tooltip use while the bundled global catalogue still matches.
    const added = { ...data.bundle.tooltips[30], hash: 32 };
    await act(async () => acceptSaved({}, [added], fixtureHead(2)));
    expect(host.querySelector('[data-global-usage="t:32"] a')?.getAttribute('href')).toBe(
      '/t/32?lang=en&variant=32&line=1',
    );
    await act(async () => acceptSaved({}, [], fixtureHead(3), [32]));
    expect(host.querySelector('[data-global-usage="t:32"]')).toBeNull();

    // B: the Worker can already know a global the refreshed bundle does not contain.
    const older = {
      ...data,
      bundle: { ...data.bundle, globals: { ...data.bundle.globals!, entries: [damage] } },
    };
    artifact = publish(older);
    await act(async () => useDataStore.setState({ data: older }));
    await act(async () => navigate(`/globals/${title.id}`));
    await expectHref('/t/31?lang=en&variant=31&line=1');
    artifact = publish(data);
    await act(async () => useDataStore.setState({ data }));
    await act(async () => navigate(`/globals/${damage.id}`));

    let saved = snapshot;
    for (const revision of ['r2', 'r3']) {
      await act(() => change(`Saved ${revision}`));
      const next = structuredClone(saved);
      next.head = fixtureHead(next.head === snapshot.head ? 2 : 3);
      const entry = next.entries[0];
      entry.revision = revision;
      entry.definitions.en!.body = `Saved ${revision}`;
      globals.mutate.mockResolvedValueOnce({ kind: 'ok', value: next });
      await act(async () => button('Save').click());
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(href()).toBe('/t/30?lang=en&variant=30&line=1');
      });
      saved = next;
    }
    await act(async () => navigate(`/globals/${title.id}`));
    await expectHref('/t/31?lang=en&variant=31&line=1');
    await act(async () => navigate(`/globals/${damage.id}`));

    // The existing save overlay replaces tooltips independently of the globals catalogue.
    await act(async () => applyHeadToData(30, null));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.textContent).toContain('Not used by any tooltip.');
      expect(href()).toBeUndefined();
    });
    await act(async () => applyHeadToData(30, data.bundle.tooltips[30]));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(href()).toBe('/t/30?lang=en&variant=30&line=1');
    });

    // A refresh catches up with the saves, with one tooltip now absent from editor-data.
    const refreshed = {
      ...data,
      bundle: {
        ...data.bundle,
        sourceCommit: saved.head,
        tooltips: { 31: data.bundle.tooltips[31] },
        globals: { ...data.bundle.globals!, entries: saved.entries },
      },
    };
    artifact = publish(refreshed);
    expect(artifact.usages[damage.id]).toEqual(empty);
    const beforeRefresh = fetchArtifact.mock.calls.length;
    await act(async () => useDataStore.setState({ data: refreshed }));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.textContent).toContain('Not used by any tooltip.');
    });
    expect(fetchArtifact).toHaveBeenCalledTimes(beforeRefresh + 1);

    // C: another global acquires a direct use and its tooltip acquires a transitive use.
    await act(async () => navigate(`/globals/${title.id}`));
    const changed = structuredClone(saved);
    changed.head = fixtureHead(4);
    changed.entries[1].revision = 'r2';
    changed.entries[1].definitions.en!.body = 'Reloads with #Damage';
    await act(() => change('Reloads with #Damage'));
    globals.mutate.mockResolvedValueOnce({ kind: 'ok', value: changed });
    await act(async () => button('Save').click());
    await act(async () => navigate(`/globals/${damage.id}`));
    await vi.waitFor(async () => {
      await act(async () => {});
      const row = host.querySelector(`[data-global-usage="g:${title.id}"] a`);
      expect(row?.getAttribute('href')).toBe(`/globals/${title.id}?lang=en`);
      expect(host.querySelector('[data-global-usage="t:31"]')?.textContent).toContain(
        'Through [Reload]',
      );
    });
  },
);

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
