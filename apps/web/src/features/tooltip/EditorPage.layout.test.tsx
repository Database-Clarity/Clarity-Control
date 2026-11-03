// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { ClarityEditor, type ClarityEditorProps } from '../editor';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';

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
  PreviewColumn: ({
    baseText,
    name,
    enhanced,
  }: {
    baseText: string;
    name: string;
    enhanced: { name: string }[];
  }) =>
    createElement(
      'div',
      { 'data-preview': name, 'data-enhanced': enhanced.map((view) => view.name).join('|') },
      baseText,
    ),
}));
vi.mock('../compendium/CompendiumPanel', () => ({
  CompendiumPanel: ({ base }: { base: Tooltip }) =>
    createElement('aside', { 'data-compendium': base.hash }, 'Compendium panel'),
}));
vi.mock('../history/HistoryPanel', () => ({
  HistoryPanel: ({ hash }: { hash: number }) => createElement('div', { 'data-history': hash }),
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

async function render(path = '/t/10') {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/t/:hash', element: createElement(TooltipPage) }),
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

  it('shows Stored form to maintainers for the derived version, read only, in a popover', async () => {
    await render();
    expect(button('Stored form')).toBeDefined();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button('Stored form')!.click());
    const popover = host.querySelector('[role="dialog"]')!;
    expect(popover.getAttribute('aria-label')).toBe('Stored form');
    expect(popover.querySelector('[data-editor="stored"]')?.hasAttribute('data-readonly')).toBe(
      true,
    );
    // Escape closes it.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    signIn('editor');
    await render();
    expect(button('Stored form')).toBeUndefined();
  });

  it('gives a translator the same editor and rows, with English but no Compendium', async () => {
    signIn('translator');
    await render('/t/10?lang=de');
    expect(editors().map((node) => node.dataset.editor)).toEqual(['10']);
    expect(host.querySelector('[data-compendium]')).toBeNull();
    expect(button('English')).toBeDefined();
    expect(button('Compendium')).toBeUndefined();
    expect(host.querySelector('[data-associations]')).not.toBeNull();
    expect(host.querySelector('[data-history]')).not.toBeNull();
    expect(button('Stored form')).toBeUndefined();
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

  it('on a phone: Editor / Preview / Compendium views, every panel mounted, one at a time', async () => {
    phone = true;
    await render();
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['Editor', 'Preview', 'Compendium']);
    const panels = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels).toHaveLength(3);
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
