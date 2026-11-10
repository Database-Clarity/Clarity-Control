import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Navigate, StaticRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TooltipPage } from './TooltipPage';
import { ClarityEditor, type ClarityEditorProps } from '../editor';
import { PreviewColumn, type PreviewColumnProps } from '../preview';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  Navigate: vi.fn(() => null),
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
vi.mock('../editor', () => ({
  ClarityEditor: vi.fn((props: ClarityEditorProps) =>
    createElement('div', { 'data-editor': props.readOnly ? 'ro' : 'rw' }, props.value),
  ),
}));
vi.mock('../preview', () => ({
  PreviewColumn: vi.fn((props: PreviewColumnProps) =>
    createElement('div', { 'data-preview': true }, props.baseText),
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
vi.mock('../../services/save/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/save/state')>();
  return {
    ...actual,
    useSaveState: Object.assign(
      (selector: (state: ReturnType<typeof actual.useSaveState.getState>) => unknown) =>
        selector(actual.useSaveState.getState()),
      actual.useSaveState,
    ),
  };
});

function tooltip(hash: number, en: string, de?: string): Tooltip {
  const stamp = { updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'owner' };
  return {
    hash,
    text: { en: { text: en, ...stamp }, ...(de ? { de: { text: de, ...stamp } } : {}) },
    associated: [],
  };
}
const base = tooltip(10, 'Bundle English', 'Deutscher Text');
const data: EditorData = {
  categories: [
    { id: 'base', label: 'Base', group: 'Weapons', order: 1, legacyType: 'Weapon Frame' },
  ],
  items: {
    10: { hash: 10, name: 'Base', icon: '', categoryId: 'base', inGameDescription: '' },
  },
  aliases: {},
  bundle: {
    sourceCommit: 'abc',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips: { 2: tooltip(2, 'v'), 3: tooltip(3, 't'), 10: base },
    permissions: { users: {} },
    pushed: {},
  },
};

function render(location: string): string {
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
const translator = {
  id: 1,
  login: 'tina',
  role: 'translator' as const,
  languages: ['de' as const],
};
const editor = { id: 2, login: 'ed', role: 'editor' as const };

describe('translator tooltip page', () => {
  const originals = {
    data: useDataStore.getState(),
    drafts: useDraftStore.getState(),
    auth: useAuthStore.getState(),
    save: useSaveState.getState(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    useDataStore.setState({ data, status: 'ready' });
    useAuthStore.setState({ user: translator });
    useSaveState.setState({ locked: false });
    useDraftStore.setState({ hydrated: true, drafts: {}, edit: vi.fn() });
  });
  afterEach(() => {
    useDataStore.setState(originals.data);
    useDraftStore.setState(originals.drafts);
    useAuthStore.setState(originals.auth);
    useSaveState.setState(originals.save);
  });

  it('opens a translator on their first assigned language with an editable editor and no reason', () => {
    const html = render('/t/10');
    const [props] = vi.mocked(ClarityEditor).mock.calls[0];
    expect(props.lang).toBe('de');
    expect(props.value).toBe('Deutscher Text');
    expect(props.readOnly).toBe(false);
    // The markup row is for every role and starts open until hidden (Ctrl+. toggles it).
    expect(props.markupRow).toBe(true);
    expect(html).not.toContain('Read-only');
    expect(html).not.toContain('Switch to');
  });

  it('lets the URL language win and explains the read-only English editor with a switch shortcut', () => {
    const html = render('/t/10?lang=en');
    expect(vi.mocked(ClarityEditor).mock.calls[0][0]).toMatchObject({ lang: 'en', readOnly: true });
    expect(html).toContain('Read-only: you can translate German, not English.');
    expect(html).toMatch(/<button[^>]*>Switch to German<\/button>/);
    expect(html).not.toContain('English source');
  });

  it('keeps provenance and the read-only reason in the 28px pane header', () => {
    const html = render('/t/10?lang=en');
    const header =
      /<div class="[^"]*paneHeader[^"]*"[^>]*>([\s\S]*?)<\/div><div[^>]*data-panel/.exec(
        html,
      )?.[1] ?? '';

    expect(header).toContain('aria-label="Language"');
    // Who edited it and when live in the History row, not in a button of the header.
    expect(header).not.toContain('Details');
    // The badge only names the state; the sentence is the status bar's, and the badge's tooltip.
    expect(header).toMatch(/role="status"[^>]*title="Read-only: you can translate German[^"]*"/);
    expect(header).toMatch(/role="status"[^>]*>[\s\S]*?<span[^>]*>Read-only<\/span>/);
    expect(header.replace(/title="[^"]*"/g, '')).not.toContain('you can translate German');
    expect(header).toContain('Switch to German');
    expect(html).not.toContain('Read-only details');
  });

  it.each([
    ['translator', { ...translator, languages: ['de' as const, 'fr' as const] }],
    ['editor', editor],
  ])('redirects an alias to the French workspace for an %s', (_role, user) => {
    const french = {
      text: 'Texte français',
      updatedAt: '2026-10-27T00:00:00Z',
      updatedBy: 'owner',
    };
    const translated = { ...base, text: { ...base.text, fr: french } };
    useAuthStore.setState({ user });
    useDataStore.setState({
      data: {
        ...data,
        aliases: { 40: { to: 10, kind: 'sandbox' } },
        bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 10: translated } },
      },
    });

    render('/t/40?lang=fr&line=3&variant=40');
    expect(vi.mocked(Navigate).mock.calls[0][0]).toMatchObject({
      to: '/t/10?lang=fr',
      replace: true,
    });
    render('/t/10?lang=fr');
    expect(vi.mocked(ClarityEditor).mock.calls[0][0]).toMatchObject({
      lang: 'fr',
      value: 'Texte français',
      readOnly: false,
    });
  });

  it('drops invalid language and obsolete highlights when redirecting an alias', () => {
    useDataStore.setState({ data: { ...data, aliases: { 40: { to: 10, kind: 'sandbox' } } } });
    render('/t/40?lang=invalid&line=3&variant=40');
    expect(vi.mocked(Navigate).mock.calls[0][0]).toMatchObject({ to: '/t/10', replace: true });
  });

  it.each([
    ['signed out', () => useAuthStore.setState({ user: null }), /sign in to edit/],
    [
      'drafts loading',
      () => useDraftStore.setState({ hydrated: false }),
      /loading your local drafts/,
    ],
    ['save review open', () => useSaveState.setState({ locked: true }), /open save review/],
  ])('shows the %s reason next to the editor', (_name, arrange, message) => {
    arrange();
    const html = render('/t/10?lang=de');
    expect(vi.mocked(ClarityEditor).mock.calls[0][0].readOnly).toBe(true);
    expect(html).toMatch(message);
    expect(html).not.toContain('Switch to');
  });

  it('shows English editor and panel tabs without a translation source', () => {
    useAuthStore.setState({ user: editor });
    const html = render('/t/10');
    expect(vi.mocked(ClarityEditor).mock.calls[0][0].markupRow).toBe(true);
    expect(html).not.toContain('Read-only');
    expect(html).not.toContain('English source');
    expect(html).toContain('role="tablist"');
  });

  describe('English source view', () => {
    it('shows the bundle English for a non-English language', () => {
      const html = render('/t/10?lang=de');
      expect(html).toContain('English source');
      expect(html).toContain('Bundle English');
    });
    it('prefers the draft English over the bundle', () => {
      useDraftStore.setState({
        drafts: { 10: { base, next: tooltip(10, 'Draft English', 'Deutscher Text') } },
      });
      const html = render('/t/10?lang=de');
      expect(html).toContain('Draft English');
      expect(html).not.toContain('Bundle English');
    });
    it('says so when there is no English text', () => {
      useDataStore.setState({
        data: {
          ...data,
          bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 10: tooltip(10, '') } },
        },
      });
      expect(render('/t/10?lang=de')).toContain('This tooltip has no English text yet.');
    });
  });

  describe('tablist', () => {
    it('renders Editor · Preview · English with ARIA tab semantics', () => {
      const html = render('/t/10?lang=de');
      // Each label sits in its own span (it ellipsises inside an equal-width phone tab).
      const tabs = [
        ...html.matchAll(/<button[^>]*role="tab"[^>]*><span[^>]*>([^<]*)<\/span><\/button>/g),
      ];
      expect(tabs.map((match) => match[1])).toEqual(['Editor', 'Preview', 'English']);
      expect(html).toContain('role="tablist"');
      expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
      expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
      for (const [tag] of tabs) {
        const controls = /aria-controls="([^"]+)"/.exec(tag)?.[1] ?? '';
        const id = /\bid="([^"]+)"/.exec(tag)?.[1] ?? '';
        expect(controls).not.toBe('');
        expect(html).toContain(`id="${controls}"`);
        expect(html).toContain(`aria-labelledby="${id}"`);
      }
      expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    });
    it('keeps the editor and preview mounted while another panel is active', () => {
      const html = render('/t/10?lang=de');
      expect(vi.mocked(ClarityEditor)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(PreviewColumn)).toHaveBeenCalledTimes(1);
      const panel = (name: string) =>
        new RegExp(`<div[^>]*data-panel="${name}"[^>]*data-active="(true|false)"[^>]*>(.*?)</div>`);
      expect(html.match(panel('translation'))?.[1]).toBe('true');
      expect(html.match(panel('source'))?.[1]).toBe('false');
      const preview = html.match(panel('preview'));
      expect(preview?.[1]).toBe('false');
      expect(preview?.[2]).toContain('data-preview');
      expect(html).toContain('data-editor="rw"');
    });
  });

  describe('associations and history', () => {
    it('shows the same compact rows to translators as to everyone else', () => {
      const html = render('/t/10?lang=de');
      expect(html).not.toContain('Associations and history');
      expect(html).toContain('Associated tooltips');
      expect(html).toContain('>History<');
      expect(html).not.toContain('Association editing requires an editor account');
    });
    it('keeps the same rows for other roles', () => {
      useAuthStore.setState({ user: editor });
      const html = render('/t/10');
      expect(html).not.toContain('Associations and history');
      expect(html).toContain('Associated tooltips');
    });
  });
});
