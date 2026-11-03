import { compendiumDataSchema } from '@clarity/core';
import { useCompendiumStore } from '../compendium/store';
import frozen from '../compendium/fixtures/frozen-matcher.json';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { ClarityEditor, type ClarityEditorProps } from '../editor';
import { PreviewColumn, type PreviewColumnProps } from '../preview';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { apiUrl } from '../../services/api';

vi.mock('../compendium/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compendium/store')>();
  return {
    ...actual,
    useCompendiumStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useCompendiumStore.getState>) => unknown) =>
        selector(actual.useCompendiumStore.getState()),
      actual.useCompendiumStore,
    ),
  };
});
vi.mock('../editor', () => ({
  ClarityEditor: vi.fn((props: ClarityEditorProps) => createElement('div', null, props.value)),
}));
vi.mock('../preview', () => ({
  PreviewColumn: vi.fn((props: PreviewColumnProps) => createElement('div', null, props.baseText)),
}));
vi.mock('../compendium/CompendiumPanel', () => ({
  CompendiumPanel: vi.fn(({ base }: { base: Tooltip }) =>
    createElement('aside', { 'data-compendium-hash': base.hash }, 'Compendium'),
  ),
}));
vi.mock('../../stores/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/data')>();
  return {
    ...actual,
    useDataStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useDataStore.getState>) => unknown) =>
        selector(actual.useDataStore.getState()),
      actual.useDataStore,
    ),
  };
});
vi.mock('../../stores/drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/drafts')>();
  return {
    ...actual,
    useDraftStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useDraftStore.getState>) => unknown) =>
        selector(actual.useDraftStore.getState()),
      actual.useDraftStore,
    ),
  };
});
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    useAuthStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useAuthStore.getState>) => unknown) =>
        selector(actual.useAuthStore.getState()),
      actual.useAuthStore,
    ),
  };
});

function tooltip(hash: number, text: string): Tooltip {
  return {
    hash,
    text: { en: { text, updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'owner' } },
    associated: [],
  };
}
const base = tooltip(10, '<enhanced Raw base markup />');
const enhanced = tooltip(11, 'Raw enhanced markup');
const global = tooltip(1, 'Original imports');
const data: EditorData = {
  categories: [
    { id: 'base', label: 'Base category', group: 'Weapons', order: 1, legacyType: 'Weapon Frame' },
    {
      id: 'enhanced',
      label: 'Enhanced category',
      group: 'Weapons',
      order: 2,
      legacyType: 'Weapon Frame Enhanced',
    },
  ],
  items: {
    10: {
      hash: 10,
      name: 'Base',
      icon: '/base.png',
      categoryId: 'base',
      inGameDescription: '',
      enhancedHashes: [11],
    },
    11: {
      hash: 11,
      name: 'Enhanced',
      icon: '/enhanced.png',
      categoryId: 'enhanced',
      inGameDescription: '',
      baseHash: 10,
    },
  },
  aliases: {},
  bundle: {
    sourceCommit: 'abc',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips: {
      1: global,
      2: tooltip(2, 'Raw variables'),
      3: tooltip(3, 'Raw titles'),
      10: base,
      11: enhanced,
    },
    permissions: { users: {} },
    pushed: {},
  },
};

function render(location = '/t/10') {
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/t/:hash', element: createElement(TooltipPage) }),
      ),
    ),
  );
}

/** The column's props as one preview per render it can show: the base, then each enhanced version. */
function previewsOf() {
  return vi.mocked(PreviewColumn).mock.calls.flatMap(([props]) => [
    {
      text: props.baseText,
      lang: props.lang,
      globals: props.baseGlobals,
      name: props.name,
      icon: props.icon,
      categoryLabel: props.categoryLabel,
    },
    ...props.enhanced.map((view) => ({
      text: view.text,
      lang: props.lang,
      globals: view.globals,
      name: view.name,
      icon: undefined,
      categoryLabel: undefined,
    })),
  ]);
}

describe('tooltip screen composition', () => {
  const originalDraftState = useDraftStore.getState();
  const originalDataState = useDataStore.getState();
  const originalAuthState = useAuthStore.getState();
  beforeEach(() => {
    vi.clearAllMocks();
    useDataStore.setState({ data, status: 'ready' });
    useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'editor' } });
    useDraftStore.setState({
      hydrated: true,
      drafts: { 1: { base: global, next: tooltip(1, 'Draft imports') } },
      edit: vi.fn(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useDraftStore.setState(originalDraftState);
    useDataStore.setState(originalDataState);
    useAuthStore.setState(originalAuthState);
  });
  it('wires ONE base editor, draft-aware imports and a preview for the base and its override', () => {
    render();
    const editors = vi.mocked(ClarityEditor).mock.calls.map(([props]) => props);
    const previews = previewsOf();
    expect(editors).toHaveLength(1);
    expect(previews).toHaveLength(2);
    expect(editors[0].value).toBe(base.text.en?.text);
    // The enhanced version keeps its own text (it does not render like the base), so it previews as is.
    expect(previews.map((props) => props.text)).toEqual([
      base.text.en?.text,
      enhanced.text.en?.text,
    ]);
    for (const props of [...editors, ...previews]) {
      expect(props.lang).toBe('en');
      expect(props.globals).toMatchObject({
        variables: 'Raw variables',
        titles: 'Raw titles',
        imports: { 1: 'Draft imports', 10: base.text.en?.text, 11: enhanced.text.en?.text },
      });
    }
    expect(editors[0].globals.type).toBe('Weapon Frame');
    expect(previews.map((props) => props.globals.type)).toEqual([
      'Weapon Frame',
      'Weapon Frame Enhanced',
    ]);
    // One column carries the base's header; the enhanced version is a view of it.
    expect(previews[1]).toMatchObject({ name: 'Enhanced' });
    expect(previews[0]).toMatchObject({ icon: '/base.png' });
    expect(editors[0].readOnly).toBe(!apiUrl);
  });
  it('keeps the one Compendium panel on the base, in English and translation workspaces', () => {
    for (const [location, role] of [
      ['/t/10', 'editor'],
      ['/t/10?lang=fr', 'maintainer'],
    ] as const) {
      vi.mocked(CompendiumPanel).mockClear();
      useAuthStore.setState({
        user: { id: 1, login: 'alice', role, languages: ['fr'] },
      });
      const markup = render(location);
      expect(vi.mocked(CompendiumPanel).mock.calls.map(([props]) => props.base)).toEqual([base]);
      expect(markup).toContain('data-compendium-hash="10"');
      expect(markup).not.toContain('data-compendium-hash="11"');
    }
  });
  it('hides Compendium from translators and shows changes only for outdated translations', () => {
    useAuthStore.setState({
      user: { id: 1, login: 'alice', role: 'translator', languages: ['fr'] },
    });
    const translated = {
      ...base,
      text: {
        ...base.text,
        fr: {
          text: 'Bonjour',
          updatedAt: '2026-10-20T00:00:00Z',
          updatedBy: 'alice',
          sourceUpdatedAt: '2026-10-20T00:00:00Z',
        },
      },
    };
    useDataStore.setState({
      data: {
        ...data,
        bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 10: translated } },
      },
    });
    const markup = render('/t/10?lang=fr');
    expect(markup).toContain('aria-label="English shows"');
    expect(markup).toContain('Changes since translation');
    expect(markup).not.toContain('data-compendium-hash');
    translated.text.fr.sourceUpdatedAt = '2026-10-27T00:00:00Z';
    expect(render('/t/10?lang=fr')).not.toContain('English shows');
    useDataStore.setState({ data });
    expect(render('/t/10?lang=fr')).not.toContain('English shows');
  });
  it('shows the shared-perk callout in the header only when 2+ exotics own the perk', () => {
    expect(render()).not.toContain('Shared perk');
    const owned = (owners: number[]): EditorData => ({
      ...data,
      items: {
        ...data.items,
        10: { ...data.items[10], owners, ownerNames: { 30: 'Exotic <B>' } },
        20: { hash: 20, name: 'Exotic <A>', icon: '', categoryId: 'base', inGameDescription: '' },
      },
    });
    useDataStore.setState({ data: owned([20, 30]) });
    expect(render()).toContain('Shared perk — used on: Exotic &lt;A&gt;, Exotic &lt;B&gt;');
    useDataStore.setState({ data: owned([20]) });
    expect(render()).not.toContain('Shared perk');
  });
  it('reuses the shared-perk editor note for current artifact parents', () => {
    const previous = useCompendiumStore.getState().data;
    const source = compendiumDataSchema.parse({
      fetchedAt: '2026-11-02T00:00:00Z',
      tabs: [frozen.artifactSource],
    });
    try {
      useCompendiumStore.setState({ data: source });
      useDataStore.setState({
        data: {
          ...data,
          items: {
            ...data.items,
            2903198437: {
              hash: 2903198437,
              name: 'Armorsmith',
              categoryId: 'armor-mod-seasonal',
              icon: '',
              inGameDescription: '',
            },
          },
        },
      });
      expect(render('/t/2903198437')).toContain(
        'Shared perk — used on: Encrypted Data Disk, Queensfoil Censer',
      );
      source.tabs[0].grid = source.tabs[0].grid!.filter(
        (c) => !c.cell.plain.startsWith('Queensfoil Censer ('),
      );
      useCompendiumStore.setState({ data: structuredClone(source) });
      expect(render('/t/2903198437')).not.toContain('Shared perk — used on:');
    } finally {
      useCompendiumStore.setState({ data: previous });
    }
  });
  it('sends a base edit to the base, and an override edit to that exact enhanced tooltip', () => {
    render();
    vi.mocked(ClarityEditor).mock.calls[0][0].onChange('Edited base');
    expect(useDraftStore.getState().edit).toHaveBeenCalledWith(base, 'en', 'Edited base', 'alice');
    vi.mocked(ClarityEditor).mockClear();
    // ?variant= opens the override in the editor slot; the base editor stays mounted beside it.
    render('/t/10?variant=11');
    const editors = vi.mocked(ClarityEditor).mock.calls.map(([props]) => props);
    expect(editors.map((props) => props.tooltipHash)).toEqual([10, 11]);
    editors[1].onChange('Edited enhanced');
    expect(useDraftStore.getState().edit).toHaveBeenCalledWith(
      enhanced,
      'en',
      'Edited enhanced',
      'alice',
    );
  });
  it('renders a derived enhanced version from the base text, with no editor of its own', () => {
    const derived = tooltip(11, base.text.en!.text);
    useDataStore.setState({
      data: {
        ...data,
        bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 11: derived } },
      },
    });
    useDraftStore.setState({
      drafts: { 10: { base, next: tooltip(10, '<enhanced Edited base />') } },
    });
    const markup = render('/t/10?variant=11');
    expect(vi.mocked(ClarityEditor)).toHaveBeenCalledTimes(1);
    const previews = previewsOf();
    // The draft base text flows into the enhanced preview, read with the enhanced type.
    expect(previews.map((props) => props.text)).toEqual([
      '<enhanced Edited base />',
      '<enhanced Edited base />',
    ]);
    expect(previews[1].globals.type).toBe('Weapon Frame Enhanced');
    expect(markup).not.toContain('Edit override');
  });
  it('offers no override for a blank copy, and Stored form only to maintainers on derived versions', () => {
    const blank = tooltip(11, '');
    const derived = tooltip(11, base.text.en!.text);
    for (const [variant, role, edit, stored] of [
      [blank, 'editor', false, false],
      [derived, 'editor', false, false],
      [derived, 'maintainer', false, true],
      [enhanced, 'maintainer', true, false],
    ] as const) {
      useAuthStore.setState({ user: { id: 1, login: 'alice', role } });
      useDataStore.setState({
        data: {
          ...data,
          bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 11: variant } },
        },
      });
      const markup = render();
      expect(markup.includes('Edit override')).toBe(edit);
      expect(markup.includes('Stored form')).toBe(stored);
    }
  });
  it('composes one frame editor and projects shared imports into both editor and preview', () => {
    useDataStore.setState({
      data: {
        ...data,
        aliases: { 11: { to: 10, kind: 'frame' } },
      },
    });
    render();
    const editors = vi.mocked(ClarityEditor).mock.calls.map(([props]) => props);
    const previews = previewsOf();
    expect(editors).toHaveLength(1);
    expect(previews).toHaveLength(1);
    for (const props of [...editors, ...previews]) {
      expect(props.globals.imports?.[11]).toBe(base.text.en?.text);
    }
  });
});
