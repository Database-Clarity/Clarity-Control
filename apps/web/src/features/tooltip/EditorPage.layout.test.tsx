// @vitest-environment jsdom
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { ClarityEditor, type ClarityEditorProps } from '../editor';
import { PreviewColumn, type PreviewColumnProps } from '../preview';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { useSteppingActivity } from '../navigation/steppingActivity';
import { useCompendiumStore } from '../compendium/store';

const originalCompendium = useCompendiumStore.getState();

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
vi.mock('../editor', () => ({
  ClarityEditor: vi.fn((props: ClarityEditorProps) =>
    createElement(
      'div',
      {
        'data-editor': props.tooltipHash ?? 'stored',
        'data-readonly': props.readOnly ? '' : undefined,
      },
      props.value,
    ),
  ),
}));
vi.mock('../preview', () => ({
  PreviewColumn: vi.fn(function MockPreviewColumn({
    baseText,
    name,
    enhanced,
    acknowledgement,
    hash,
    onDocumentPaint,
  }: PreviewColumnProps) {
    useEffect(() => onDocumentPaint?.(hash), [hash, onDocumentPaint]);
    return createElement(
      Fragment,
      null,
      createElement(
        'div',
        { 'data-preview': name, 'data-enhanced': enhanced.map((view) => view.name).join('|') },
        baseText,
      ),
      acknowledgement,
    );
  }),
}));
vi.mock('../compendium/CompendiumPanel', () => ({
  CompendiumPanel: ({ base, stepping }: { base: Tooltip; stepping?: boolean }) =>
    createElement(
      'aside',
      { 'data-compendium': base.hash, 'data-stepping': stepping || undefined },
      'Compendium panel',
    ),
}));
vi.mock('../history/HistoryPanel', () => ({
  HistoryPanel: ({
    hash,
    suspended,
    attribution,
  }: {
    hash: number;
    suspended?: boolean;
    attribution?: React.ReactNode;
  }) =>
    createElement(
      'div',
      { 'data-history': hash, 'data-suspended': suspended || undefined },
      attribution,
    ),
}));
vi.mock('../associations/AssociationsPanel', () => ({
  AssociationsPanel: ({ hash }: { hash: number }) =>
    createElement('div', { 'data-associations': hash }),
}));

const stamp = { updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'owner' };
const tip = (hash: number, en: string, extra: Record<string, string> = {}): Tooltip => ({
  hash,
  associated: [],
  text: {
    en: { text: en, ...stamp },
    ...Object.fromEntries(Object.entries(extra).map(([lang, text]) => [lang, { text, ...stamp }])),
  },
});
const item = (hash: number, name: string, categoryId: string, baseHash?: number) => ({
  hash,
  name,
  icon: '',
  categoryId,
  inGameDescription: '',
  ...(baseHash ? { baseHash } : {}),
});
const BASE = 'Deals #e${1+#d} damage.';
// 10 has a derived enhanced version (11) and an override (12); 13 is a blank copy.
const data = {
  categories: [
    { id: 'trait', label: 'Trait', group: 'W', order: 1, legacyType: 'Weapon Trait' },
    { id: 'enh', label: 'Enhanced', group: 'W', order: 2, legacyType: 'Weapon Trait Enhanced' },
  ],
  items: {
    10: item(10, 'Base perk', 'trait'),
    11: item(11, 'Base perk enhanced', 'enh', 10),
    12: item(12, 'Other perk enhanced', 'enh', 10),
    13: item(13, 'Base perk copy', 'trait', 10),
  },
  aliases: {},
  bundle: {
    sourceCommit: 'x',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips: {
      1: tip(1, ''),
      2: tip(2, ''),
      3: tip(3, ''),
      10: tip(10, BASE, { de: 'Deutsch #e${1+#d}' }),
      11: tip(11, BASE, { de: 'Deutsch #e${1+#d}' }),
      12: tip(12, 'Its own words'),
      13: tip(13, ''),
    },
    permissions: { users: {} },
    pushed: {},
  },
} as unknown as EditorData;

let host: HTMLDivElement;
let root: Root;
let phone = false;
const originals = {
  data: useDataStore.getState(),
  drafts: useDraftStore.getState(),
  auth: useAuthStore.getState(),
  save: useSaveState.getState(),
};

let navigateRoute: ReturnType<typeof useNavigate>;
let currentLocation: ReturnType<typeof useLocation>;
function PageHarness() {
  navigateRoute = useNavigate();
  currentLocation = useLocation();
  return <TooltipPage />;
}
async function render(path = '/t/10') {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/t/:hash', element: createElement(PageHarness) }),
        ),
      ),
    ),
  );
}
const editors = () => [...host.querySelectorAll<HTMLElement>('[data-editor]')];
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name);
const signIn = (role: 'maintainer' | 'editor' | 'translator' | null) =>
  useAuthStore.setState({
    user: role ? { id: 1, login: 'alice', role, languages: ['de'] } : null,
  });

beforeEach(() => {
  useSteppingActivity.setState({ active: false, deferWorkspace: false, target: undefined });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  phone = false;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: /max-width:\s*700px/.test(query) ? phone : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  useDataStore.setState({ data, status: 'ready' });
  useDraftStore.setState({ hydrated: true, drafts: {}, edit: vi.fn(), discard: vi.fn() });
  useSaveState.setState({ locked: false });
  signIn('maintainer');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as { matchMedia?: unknown }).matchMedia;
  useDataStore.setState(originals.data);
  useDraftStore.setState(originals.drafts);
  useAuthStore.setState(originals.auth);
  useSaveState.setState(originals.save);
  vi.mocked(ClarityEditor).mockClear();
  useSteppingActivity.setState({ active: false, deferWorkspace: false, target: undefined });
  vi.useRealTimers();
});

it('keeps the editor mounted while replacing an alias URL with its canonical route', async () => {
  vi.useFakeTimers();
  useDataStore.setState({
    data: {
      ...data,
      aliases: { 21: { to: 20, kind: 'frame' } },
      items: { ...data.items, 20: item(20, 'Next perk', 'trait') },
      bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 20: tip(20, 'Next text') } },
    },
  });
  await render();
  const editor = editors()[0];
  vi.mocked(ClarityEditor).mockClear();
  await act(async () => navigateRoute('/t/21?lang=en&line=1'));
  expect(currentLocation.pathname).toBe('/t/20');
  expect(currentLocation.search).toBe('?lang=en');
  expect(vi.mocked(ClarityEditor).mock.calls.some(([props]) => props.highlightLine === 1)).toBe(
    false,
  );
  expect(editors()[0]).toBe(editor);
  expect(editor.textContent).toBe('Next text');
  expect(editor.dataset.editor).toBe('20');
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(host.querySelector('[data-compendium]')?.getAttribute('data-compendium')).toBe('20');
  await act(async () => navigateRoute('/t/21?lang=en&line=1'));
  expect(editors()[0]).toBe(editor);
  expect(currentLocation.pathname).toBe('/t/20');
  expect(useDraftStore.getState().edit).not.toHaveBeenCalled();
});

it('retains skipped content, paints the latest admitted document, and completes its pane after preview paint', async () => {
  vi.useFakeTimers();
  useDataStore.setState({
    data: {
      ...data,
      items: { ...data.items, 20: item(20, 'Next perk', 'trait') },
      bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 20: tip(20, 'Next text') } },
    },
  });
  await render();
  const editor = editors()[0];
  const pane = host.querySelector('[data-compendium]');
  await act(async () =>
    useSteppingActivity.setState({ active: true, deferWorkspace: true, target: '/t/20' }),
  );
  expect(host.querySelector('[data-compendium]')).toBe(pane);
  expect(pane?.getAttribute('data-stepping')).toBe('true');
  expect(host.querySelector('[data-history]')?.getAttribute('data-suspended')).toBe('true');
  vi.mocked(ClarityEditor).mockClear();
  vi.mocked(PreviewColumn).mockClear();
  await act(async () => navigateRoute('/t/20'));
  expect(ClarityEditor).not.toHaveBeenCalled();
  expect(PreviewColumn).not.toHaveBeenCalled();
  expect(editors()[0]).toBe(editor);
  expect(editor.textContent).toBe(BASE);
  expect(host.querySelector('[data-preview]')?.textContent).toBe(BASE);
  expect(currentLocation.pathname).toBe('/t/20');
  expect(host.querySelector('article[aria-busy=true]')).not.toBeNull();
  await act(async () => useSteppingActivity.setState({ deferWorkspace: false }));
  expect(editors()[0]).toBe(editor);
  expect(editor.dataset.editor).toBe('20');
  expect(editor.textContent).toBe('Next text');
  expect(host.querySelector('[data-preview]')?.textContent).toBe('Next text');
  expect(vi.mocked(PreviewColumn).mock.calls.at(-1)?.[0].hash).toBe(20);
  expect(host.querySelector('[data-compendium]')).toBe(pane);
  expect(pane?.getAttribute('data-compendium')).toBe('10');
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(pane?.getAttribute('data-compendium')).toBe('20');
  await act(async () => useSteppingActivity.setState({ active: false }));
  expect(editors()[0]).toBe(editor);
  expect(editors()[0].textContent).toBe('Next text');
  expect(host.querySelector('[data-history]')?.getAttribute('data-history')).toBe('20');
  expect(host.querySelector('[data-compendium]')).toBe(pane);
  expect(pane?.hasAttribute('data-stepping')).toBe(false);
  expect(host.querySelector('article[aria-busy=true]')).toBeNull();
});

describe('inline conflicts on the page', () => {
  const marked = 'Deals X.\n<<<<<<< mine\nMine line\n=======\nTheirs line\n>>>>>>> theirs (bob)';
  it('keeps the markers in the editor but previews "mine" and the derived version too', async () => {
    useDraftStore.setState({
      drafts: { 10: { base: data.bundle.tooltips[10]!, next: tip(10, marked) } },
    });
    await render();
    expect(editors()[0]!.textContent).toBe(marked);
    expect(host.querySelector('[data-preview]')?.textContent).toBe('Deals X.\nMine line');
  });

  it('rows point to another language that carries blocks, and open it', async () => {
    useDraftStore.setState({
      drafts: {
        10: { base: data.bundle.tooltips[10]!, next: tip(10, BASE, { de: marked }) },
      },
    });
    await render();
    const row = host.querySelector('[data-conflict-rows]')!;
    expect(row.textContent).toContain('German');
    expect(row.textContent).toContain('1 conflict in the text');
  });

  it('pauses editing while another tab changed the drafts and conflicts are open', async () => {
    useDraftStore.setState({
      external: true,
      drafts: { 10: { base: data.bundle.tooltips[10]!, next: tip(10, marked) } },
    });
    await render();
    const props = vi.mocked(ClarityEditor).mock.calls.at(-1)![0];
    expect(props.readOnly).toBe(true);
    expect(props.readOnlyReason).toContain('Paused: another tab changed your drafts');
    // Without an open conflict another tab's write does not stop the editor.
    await act(async () => useDraftStore.setState({ external: true, drafts: {} }));
    expect(vi.mocked(ClarityEditor).mock.calls.at(-1)![0].readOnly).toBe(false);
  });
});

describe('editor page composition', () => {
  it('mounts one editor per item and shows one preview column with each enhanced version as a view', async () => {
    await render();
    expect(editors().map((node) => node.dataset.editor)).toEqual(['10']);
    // One column, one header: the base, with each enhanced version a view of it.
    expect(
      [...host.querySelectorAll('[data-preview]')].map((n) => n.getAttribute('data-preview')),
    ).toEqual(['Base perk']);
    expect(host.querySelector('[data-preview]')?.getAttribute('data-enhanced')).toBe(
      'Base perk enhanced|Other perk enhanced',
    );
    // The blank copy gets neither an editor nor a preview.
    expect(host.textContent).not.toContain('Base perk copy');
    // The identity header and the archived banner are gone: the page heading is for assistive tech.
    expect(host.querySelector('article > header')).toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe('Base perk');
  });

  it('keeps the base editor mounted, and its node, while an override is open', async () => {
    await render();
    const base = editors()[0];
    expect(button('Edit override')).toBeDefined();
    await act(async () => button('Edit override')!.click());
    expect(editors().map((node) => node.dataset.editor)).toEqual(['10', '12']);
    expect(editors()[0]).toBe(base);
    expect(base.closest('[hidden]')).not.toBeNull();
    expect(editors()[1].closest('[hidden]')).toBeNull();
    expect(host.textContent).toContain('Enhanced override');
    // A narrow header shows "Override" instead; screen readers hear the full name only once.
    const tag = host.querySelector('[title="Enhanced override"]')!;
    expect(tag).not.toBeNull();
    expect(
      [...tag.querySelectorAll('[aria-hidden="true"]')].map((node) => node.textContent?.trim()),
    ).toContain('Override');
    expect(button('Edit override')).toBeUndefined();
    await act(async () => button('Back to base')!.click());
    expect(editors().map((node) => node.dataset.editor)).toEqual(['10']);
    expect(editors()[0]).toBe(base);
    expect(base.closest('[hidden]')).toBeNull();
  });

  it('follows the editor in the rows: associations and history belong to the open text', async () => {
    await render();
    expect(host.querySelector('[data-history]')?.getAttribute('data-history')).toBe('10');
    await act(async () => button('Edit override')!.click());
    expect(host.querySelector('[data-history]')?.getAttribute('data-history')).toBe('12');
  });

  it('opens the override for ?variant= on an override, the base for a derived version', async () => {
    await render('/t/10?variant=12&line=1');
    expect(editors().map((node) => node.dataset.editor)).toEqual(['10', '12']);
    expect(vi.mocked(ClarityEditor).mock.calls.at(-1)?.[0].highlightLine).toBe(1);
    await act(async () => root.unmount());
    root = createRoot(host);
    vi.mocked(ClarityEditor).mockClear();
    await render('/t/10?variant=11&line=1');
    expect(editors().map((node) => node.dataset.editor)).toEqual(['10']);
    expect(vi.mocked(ClarityEditor).mock.calls.at(-1)?.[0]).toMatchObject({
      tooltipHash: 10,
      highlightLine: 1,
    });
  });

  describe('the preview view while stepping across items with and without an enhanced version', () => {
    const solo = {
      ...data,
      items: { ...data.items, 20: item(20, 'Solo perk', 'trait') },
      bundle: {
        ...data.bundle,
        tooltips: { ...data.bundle.tooltips, 20: tip(20, 'Only a base') },
      },
    } as unknown as EditorData;
    const shown = () => vi.mocked(PreviewColumn).mock.calls.at(-1)![0];
    const go = async (to: string | number) =>
      act(async () => (navigateRoute as (to: string | number) => void)(to));

    it('keeps the chosen view, falls back to Base without an enhanced form, and returns to it', async () => {
      useDataStore.setState({ data: solo });
      await render('/t/10');
      expect(shown().mode).toBe('compare');
      await act(async () => shown().onMode('enhanced'));
      expect(shown().mode).toBe('enhanced');
      await go('/t/20');
      expect(shown()).toMatchObject({ hash: 20, mode: 'base' });
      expect(shown().enhanced).toEqual([]);
      await go('/t/10');
      expect(shown()).toMatchObject({ hash: 10, mode: 'enhanced' });
      // Back and Forward keep the choice too.
      await go(-1);
      expect(shown()).toMatchObject({ hash: 20, mode: 'base' });
      await go(1);
      expect(shown()).toMatchObject({ hash: 10, mode: 'enhanced' });
    });

    it('stays on the desktop default (Compare) when nothing was chosen', async () => {
      useDataStore.setState({ data: solo });
      await render('/t/20');
      expect(shown().mode).toBe('base');
      await go('/t/10');
      expect(shown().mode).toBe('compare');
    });

    it('defaults to Enhanced on a phone and falls back to Base on a base-only item', async () => {
      phone = true;
      useDataStore.setState({ data: solo });
      await render('/t/10');
      expect(shown().mode).toBe('enhanced');
      await go('/t/20');
      expect(shown().mode).toBe('base');
      await go('/t/10');
      expect(shown().mode).toBe('enhanced');
    });
  });

  it('has no Details button: who last edited this language sits in the History row', async () => {
    await render();
    expect(button('Details')).toBeUndefined();
    const history = host.querySelector('[data-history]')!;
    expect(history.textContent).toMatch(/Edited by .* ·/);
    expect(history.textContent).toContain('Legacy tooltip upload');
  });

  it('shows maintainers the grouped manifest perks in a popover; Stored form is gone', async () => {
    await render();
    expect(button('Stored form')).toBeUndefined();
    const trigger = button('Grouped 4')!;
    expect(trigger).toBeDefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => trigger.click());
    const popover = document.querySelector('[role="dialog"]')!;
    expect(popover.getAttribute('aria-label')).toBe('Grouped manifest perks');
    const rows = [...popover.querySelectorAll<HTMLElement>('[data-grouped]')];
    expect(rows.map((row) => row.dataset.grouped)).toEqual(['10', '11', '12', '13']);
    expect(rows[0].textContent).toContain('Canonical');
    expect(rows[1].textContent).toContain('Enhanced pair');
    expect(rows[3].textContent).toContain('Base pointer');
    // Escape closes it and returns focus to the trigger.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    signIn('editor');
    await render();
    expect(button('Grouped 4')).toBeUndefined();
  });

  it('gives a translator the same editor and rows, with English and the saved Compendium only', async () => {
    signIn('translator');
    await render('/t/10?lang=de');
    expect(editors().map((node) => node.dataset.editor)).toEqual(['10']);
    // Never the live, matching Compendium panel.
    expect(host.querySelector('[data-compendium]')).toBeNull();
    expect(button('English')).toBeDefined();
    expect(button('Compendium')).toBeDefined();
    expect(host.querySelector('[data-associations]')).not.toBeNull();
    expect(host.querySelector('[data-history]')).not.toBeNull();
    expect(button('Grouped 4')).toBeUndefined();
  });

  describe('translator Compendium tab (read-only, saved snapshot only)', () => {
    const snapshot = {
      gid: '42',
      rowKey: 'Base perk',
      section: 'Raid Specific',
      sourceAnchor: { row: 12, col: 1 },
      cells: [{ dRow: 0, dCol: 2 }],
      snapshot: {
        plain: 'Saved sheet words',
        runs: [{ text: 'Saved sheet words', bold: true as const }],
      },
      snapshotAt: '2026-11-01T10:00:00Z',
    };
    const withSnapshot = (link?: typeof snapshot) => {
      const tooltips = {
        ...data.bundle.tooltips,
        10: { ...data.bundle.tooltips[10], compendium: link },
      };
      useDataStore.setState({
        data: { ...data, bundle: { ...data.bundle, tooltips } } as EditorData,
      });
    };
    const openCompendium = async () => {
      await act(async () => button('Compendium')!.click());
      return host.querySelector<HTMLElement>('[data-saved-compendium]')!;
    };
    // Every write the editors' pane offers; none may render for a translator.
    const writeActions =
      /^(Link|Relink|Close|Confirm|Not needed|Unlink|Choose another|Review & save draft|Use this|Accept)/;
    let fetchSpy: { mock: { calls: unknown[][] }; mockRestore(): void };
    let load: ReturnType<typeof vi.fn<(force?: boolean) => Promise<void>>>;
    beforeEach(() => {
      signIn('translator');
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
      load = vi.fn<(force?: boolean) => Promise<void>>(async () => {});
      useCompendiumStore.setState({ load });
    });
    afterEach(() => {
      fetchSpy.mockRestore();
      useCompendiumStore.setState(originalCompendium);
    });
    const expectNoLiveSheet = () => {
      expect(load).not.toHaveBeenCalled();
      expect(
        fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => /compendium/i.test(url)),
      ).toEqual([]);
    };

    it('shows only the snapshot saved with the English, its source, and no write action', async () => {
      withSnapshot(snapshot);
      await render('/t/10?lang=de');
      const pane = await openCompendium();
      expect(pane.dataset.savedCompendium).toBe('saved');
      expect(pane.textContent).toContain('Saved sheet words');
      expect(pane.textContent).toContain('Saved with the English');
      expect(pane.textContent).toContain('Raid Specific');
      const source = pane.querySelector<HTMLAnchorElement>('[data-source-ref]')!;
      expect(source.textContent).toContain('D12');
      expect(source.href).toContain('gid=42');
      expect(host.querySelector('[data-compendium]')).toBeNull();
      const aside = pane.closest('aside')!;
      const labels = [...aside.querySelectorAll('button')].map(
        (entry) => entry.textContent?.trim() ?? '',
      );
      expect(labels.filter((label) => writeActions.test(label))).toEqual([]);
      expectNoLiveSheet();
    });

    it('says so when no snapshot was saved, with no live fallback', async () => {
      withSnapshot(undefined);
      await render('/t/10?lang=de');
      const pane = await openCompendium();
      expect(pane.dataset.savedCompendium).toBe('none');
      expect(pane.textContent).toBe('No Compendium text was saved with the English yet');
      expect(pane.closest('aside')!.querySelectorAll('button')).toHaveLength(0);
      expectNoLiveSheet();
    });

    it('keeps the Compendium out of English mode for a translator', async () => {
      withSnapshot(snapshot);
      await render('/t/10?lang=en');
      expect(button('Compendium')).toBeUndefined();
      expect(host.querySelector('[data-saved-compendium]')).toBeNull();
    });

    it('leaves editors and maintainers on the live panel', async () => {
      withSnapshot(snapshot);
      for (const role of ['editor', 'maintainer'] as const) {
        signIn(role);
        await render('/t/10?lang=de');
        await act(async () => button('Compendium')!.click());
        expect(host.querySelector('[data-compendium]')).not.toBeNull();
        expect(host.querySelector('[data-saved-compendium]')).toBeNull();
      }
    });
  });

  it('shows the read-only reason as a header badge when signed out, with no Discard or override action', async () => {
    signIn(null);
    await render();
    const badge = host.querySelector('[role="status"]')!;
    // Short in the header (the status bar under the editor has the sentence); the tooltip keeps it.
    expect(badge.textContent).toContain('Read-only');
    expect(badge.textContent).not.toContain('sign in');
    expect(badge.getAttribute('title')).toBe('Read-only: sign in to edit.');
    expect(editors()[0].hasAttribute('data-readonly')).toBe(true);
    expect(button('Discard')).toBeUndefined();
  });

  it('shows Discard with the draft dot only while the open text has a draft', async () => {
    const draft = tip(10, 'Edited');
    useDraftStore.setState({ drafts: { 10: { base: data.bundle.tooltips[10], next: draft } } });
    await render();
    expect(host.querySelector('[aria-label="Unsaved draft"]')).not.toBeNull();
    await act(async () => button('Discard')!.click());
    expect(useDraftStore.getState().discard).toHaveBeenCalledWith(10);
  });

  it('on a phone: Editor / Preview / Compendium / Reports views, panels mounted, one at a time', async () => {
    phone = true;
    await render();
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    // Reports joins for role holders; its panel stays empty until the tab is opened.
    expect(tabs).toEqual(['Editor', 'Preview', 'Compendium', 'Reports']);
    const panels = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels).toHaveLength(4);
    expect(host.querySelector('[data-panel="reports"]')?.childElementCount).toBe(0);
    expect(host.querySelector('[data-panel="translation"]')?.getAttribute('data-active')).toBe(
      'true',
    );
    expect(host.querySelector('[data-panel="preview"]')?.getAttribute('data-active')).toBe('false');
    const editor = editors()[0];
    await act(async () =>
      (host.querySelector('[role="tab"][aria-controls$="panel-preview"]') as HTMLElement).click(),
    );
    expect(host.querySelector('[data-panel="preview"]')?.getAttribute('data-active')).toBe('true');
    expect(editors()[0]).toBe(editor);
    expect(host.querySelector('[data-panel="preview"] [data-history]')).not.toBeNull();
    expect(host.querySelector('[data-panel="compendium"] [data-compendium]')).not.toBeNull();
  });
});
