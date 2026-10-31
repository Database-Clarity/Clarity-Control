import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeWeaponTypeLabels, type Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { ClarityEditor, type ClarityEditorProps } from '../editor';
import { TooltipPreview, type TooltipPreviewProps } from '../preview';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { apiUrl } from '../../services/api';

vi.mock('../editor', () => ({
  ClarityEditor: vi.fn((props: ClarityEditorProps) => createElement('div', null, props.value)),
}));
vi.mock('../preview', () => ({
  TooltipPreview: vi.fn((props: TooltipPreviewProps) => createElement('div', null, props.text)),
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
  weaponTypeLabels: completeWeaponTypeLabels(),
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

function render() {
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: '/t/10' },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/t/:hash', element: createElement(TooltipPage) }),
      ),
    ),
  );
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
  it('wires raw text, ALL variants, draft-aware imports and per-variant legacy types to both real contracts', () => {
    render();
    const editors = vi.mocked(ClarityEditor).mock.calls.map(([props]) => props);
    const previews = vi.mocked(TooltipPreview).mock.calls.map(([props]) => props);
    expect(editors).toHaveLength(2);
    expect(previews).toHaveLength(2);
    expect(editors.map((props) => props.value)).toEqual([
      base.text.en?.text,
      enhanced.text.en?.text,
    ]);
    expect(previews.map((props) => props.text)).toEqual(editors.map((props) => props.value));
    for (const props of [...editors, ...previews]) {
      expect(props.lang).toBe('en');
      expect(props.globals).toMatchObject({
        variables: 'Raw variables',
        titles: 'Raw titles',
        imports: { 1: 'Draft imports', 10: base.text.en?.text, 11: enhanced.text.en?.text },
      });
    }
    expect(editors.map((props) => props.globals.type)).toEqual([
      'Weapon Frame',
      'Weapon Frame Enhanced',
    ]);
    expect(previews.map((props) => props.globals.type)).toEqual([
      'Weapon Frame',
      'Weapon Frame Enhanced',
    ]);
    expect(previews[1]).toMatchObject({
      name: 'Enhanced',
      icon: '/enhanced.png',
      categoryLabel: 'Enhanced category',
    });
    expect(editors.every((props) => props.readOnly === !apiUrl)).toBe(true);
  });
  it('shows the shared-perk callout in the header only when 2+ exotics own the perk', () => {
    expect(render()).not.toContain('Shared perk');
    const owned = (owners: number[]): EditorData => ({
      ...data,
      items: {
        ...data.items,
        10: { ...data.items[10], owners },
        20: { hash: 20, name: 'Exotic <A>', icon: '', categoryId: 'base', inGameDescription: '' },
      },
    });
    useDataStore.setState({ data: owned([20, 30]) });
    // Names come from the item lookup (escaped); unknown owners fall back to the hash.
    expect(render()).toContain('Shared perk — used on: Exotic &lt;A&gt;, 30');
    useDataStore.setState({ data: owned([20]) });
    expect(render()).not.toContain('Shared perk');
  });
  it('sends an enhanced edit to that exact tooltip with the signed-in author and loaded base', () => {
    render();
    vi.mocked(ClarityEditor).mock.calls[1][0].onChange('Edited enhanced');
    expect(useDraftStore.getState().edit).toHaveBeenCalledWith(
      enhanced,
      'en',
      'Edited enhanced',
      'alice',
    );
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
    const previews = vi.mocked(TooltipPreview).mock.calls.map(([props]) => props);
    expect(editors).toHaveLength(1);
    expect(previews).toHaveLength(1);
    for (const props of [...editors, ...previews]) {
      expect(props.globals.imports?.[11]).toBe(base.text.en?.text);
    }
  });
  it('passes the weapon types of the tooltip and of its aliases to the preview', () => {
    useDataStore.setState({
      data: {
        ...data,
        items: {
          10: { ...data.items[10], weaponTypes: ['Sword', 'Hand Cannon'] },
          11: { ...data.items[11], weaponTypes: ['Glaive', 'Sword'] },
        },
        aliases: { 11: { to: 10, kind: 'frame' } },
      },
    });
    render();
    const previews = vi.mocked(TooltipPreview).mock.calls.map(([props]) => props);
    expect(previews.map((props) => props.weaponTypes)).toEqual([
      ['Glaive', 'Hand Cannon', 'Sword'],
    ]);
  });
});
