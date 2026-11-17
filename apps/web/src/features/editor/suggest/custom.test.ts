// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Lang, MarkupGlobals } from '@clarity/core';
import { requestItems, suggestContext, suggestItems } from './source';
import {
  invalidateSnippetCatalogue,
  loadSnippetCatalogue,
  snippetCatalogue,
  snippetLang,
  closeSaveSnippet,
  useSaveSnippet,
} from './custom';
import {
  acceptSuggestion,
  openSuggest,
  suggestConfiguration,
  suggestExtension,
  suggestState,
} from './state';

const services = vi.hoisted(() => ({
  loadEditorSnippets: vi.fn(),
  getLocalizedSnippets: vi.fn(),
}));
vi.mock('../../../services/snippets', () => services);

const mine = [
  { id: 'me:a', label: 'Refill note', template: '<title {{1:reloads}} [G_refill] />' },
  { id: 'me:b', label: 'Bonus line', template: '<enhanced/> {{1:bonus}}' },
  { id: 'me:c', label: 'Ammo var', template: 'var ammo = {{1:3}}' },
];
const team = [
  { id: 'team:r', label: 'Refills (magazine)', template: '<title {{1:refills}} [G_refill] />' },
];

const enhanced: MarkupGlobals & { allowBaseEnhanced: boolean } = {
  allowBaseEnhanced: true,
  variables: '',
  titles: 'title G_refill (\nRefills the magazine.\n)',
};
const plain: MarkupGlobals = { variables: '', titles: enhanced.titles };

function state(doc: string, lang: Lang = 'en', anchor = doc.length, head = anchor) {
  return EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [snippetLang.of(lang)],
  });
}
function typed(doc: string, lang: Lang = 'en', globals: MarkupGlobals = enhanced) {
  const at = state(doc, lang);
  return suggestItems(suggestContext(at, false)!, at, globals);
}
function requested(doc: string, lang: Lang = 'en', anchor?: number, head?: number) {
  const at = state(doc, lang, anchor, head);
  return requestItems(suggestContext(at, true)!, at, enhanced);
}

describe('custom snippets in the menus', () => {
  beforeEach(async () => {
    services.loadEditorSnippets.mockResolvedValue({ builtIn: [], mine, team });
    services.getLocalizedSnippets.mockResolvedValue({
      snippets: [
        {
          id: 'pair',
          label: 'PvE- und PvP-Werte',
          keywords: 'werte',
          template: '<pve {{1:?}} /> <pvp [{{2:?}}] />',
          enHash: 'x',
          language: 'de',
          hint: null,
          outdated: false,
        },
        {
          id: 'team:r',
          label: 'Refills (magazine)',
          keywords: '',
          template: team[0]!.template,
          enHash: 'y',
          language: 'en',
          hint: 'EN',
          outdated: true,
        },
      ],
      outdated: ['team:r'],
      canManage: false,
    });
    await loadSnippetCatalogue(null, 'en');
    await loadSnippetCatalogue('1:editor', 'en');
    await loadSnippetCatalogue('1:editor', 'de');
  });

  test('the typed menu lists them only on a match, hinted Mine and Team', () => {
    expect(typed('<').some((item) => item.source)).toBe(false);
    const found = typed('<refill');
    const custom = found.filter((item) => item.source);
    expect(custom.map((item) => [item.label, item.hint])).toEqual([
      ['Refill note', 'Mine'],
      ['Refills (magazine)', 'Team'],
    ]);
    expect(custom[0]!.insert).toBe('<title reloads [G_refill] />');
  });

  test('empty queries keep built-in order, with custom snippets after them and recent picks first', async () => {
    const at = state('x ');
    const context = suggestContext(at, true)!;
    const snippets = (recent: string[] = []) =>
      requestItems(context, at, enhanced, recent).filter(
        (item) => item.category === 'Snippets' && item.pinned,
      );
    const withCustom = snippets();
    expect(withCustom.filter((item) => item.source).map((item) => item.id)).toEqual([
      'snippet:me:a',
      'snippet:me:b',
      'snippet:team:r',
    ]);
    const firstCustom = withCustom.findIndex((item) => item.source);
    expect(withCustom.slice(0, firstCustom).every((item) => !item.source)).toBe(true);
    expect(withCustom.slice(firstCustom).every((item) => item.source)).toBe(true);
    const recent = ['snippet:team:r', withCustom[1]!.id, 'snippet:me:a'];
    expect(
      snippets(recent)
        .slice(0, 3)
        .map((item) => item.id),
    ).toEqual(recent);
    services.loadEditorSnippets.mockResolvedValue({ builtIn: [], mine: [], team: [] });
    await loadSnippetCatalogue('empty-order:editor', 'en');
    expect(withCustom.filter((item) => !item.source).map((item) => item.id)).toEqual(
      snippets().map((item) => item.id),
    );
  });

  test('typed score ties stay Mine, Team, then built-in, regardless of recent picks', async () => {
    const label = 'PvE and PvP values';
    services.loadEditorSnippets.mockResolvedValue({
      builtIn: [],
      mine: [{ id: 'me:tie', label, template: 'x' }],
      team: [{ id: 'team:tie', label, template: 'x' }],
    });
    await loadSnippetCatalogue('typed-order:editor', 'en');
    const at = state('PvE');
    const context = suggestContext(at, true)!;
    const recent = ['snippet:pair', 'snippet:team:tie', 'snippet:me:tie'];
    for (const items of [
      requestItems(context, at, enhanced, recent),
      suggestItems(context, at, enhanced, recent),
    ]) {
      expect(items.filter((item) => item.label === label).map((item) => item.id)).toEqual([
        'snippet:me:tie',
        'snippet:team:tie',
        'snippet:pair',
      ]);
    }
    // Clearing the query restores recency rather than retaining the typed source order.
    expect(
      requestItems({ ...context, query: '' }, at, enhanced, recent)
        .filter((item) => item.category === 'Snippets')
        .slice(0, 3)
        .map((item) => item.id),
    ).toEqual(recent);
  });

  test('invalid selections explain how to fix markup, while corrected selections open the form', () => {
    closeSaveSnippet();
    const text = '<unknown text />';
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: { anchor: 0, head: text.length },
        extensions: [suggestExtension(), suggestConfiguration({ globals: enhanced }, 'en')],
      }),
    });
    try {
      openSuggest(view);
      const index = suggestState(view.state)!.items.findIndex((item) => item.saveSnippet);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(acceptSuggestion(view, index)).toBe('unavailable');
      expect(suggestState(view.state)?.message).toBe(
        'Fix the markup in the editor before saving it as a snippet.',
      );
      expect(view.state.doc.toString()).toBe(text);
      expect(useSaveSnippet.getState().text).toBeNull();
      view.dispatch({
        changes: { from: 0, to: text.length, insert: 'Corrected text' },
        selection: { anchor: 0, head: 14 },
      });
      openSuggest(view);
      const corrected = suggestState(view.state)!.items.findIndex((item) => item.saveSnippet);
      expect(acceptSuggestion(view, corrected)).toBe('inserted');
      expect(useSaveSnippet.getState().text).toBe('Corrected text');
      expect(suggestState(view.state)).toBeNull();
    } finally {
      closeSaveSnippet();
      view.destroy();
    }
  });

  test('line-start and enhanced rules apply as for built-ins', () => {
    // A declaration mid-line is listed, unavailable, as built-in declarations are.
    const ammo = requested('Text ').find((item) => item.id === 'snippet:me:c');
    expect(ammo?.unavailable).toBe('Needs an empty line.');
    // No base/enhanced in this category: the enhanced snippet is not offered.
    expect(typed('<bonus', 'en', plain).some((item) => item.id === 'snippet:me:b')).toBe(false);
    expect(typed('<bonus').some((item) => item.id === 'snippet:me:b')).toBe(true);
  });

  test('translate mode: the language words, English marked EN', () => {
    const items = requested('x ', 'de');
    expect(items.find((item) => item.id === 'snippet:pair')).toMatchObject({
      label: 'PvE- und PvP-Werte',
    });
    expect(items.find((item) => item.id === 'snippet:pair')?.hint).toBeUndefined();
    expect(items.find((item) => item.id === 'snippet:team:r')?.hint).toBe('Team · EN');
    expect(items.find((item) => item.id === 'snippet:icon-word')?.hint).toBe('EN');
    // English editing always shows English.
    expect(requested('x ').find((item) => item.id === 'snippet:pair')?.label).toBe(
      'PvE and PvP values',
    );
  });

  test('a selection offers Save as snippet first among the Snippets, without a hint', () => {
    const items = requested('Grants Bonus damage', 'en', 7, 19);
    const snippets = items.filter((item) => item.category === 'Snippets');
    expect(snippets[0]).toMatchObject({ id: 'save-snippet', saveSnippet: true });
    expect(snippets[0]!.hint).toBeUndefined();
  });

  test('a failed load leaves built-ins only', async () => {
    services.loadEditorSnippets.mockResolvedValue({ builtIn: [], mine: [], team: [] });
    await loadSnippetCatalogue('2:trial', 'en');
    expect(snippetCatalogue('en').mine).toEqual([]);
    expect(typed('<refill').some((item) => item.source)).toBe(false);
  });
});

describe('markup bar and All buttons while translating', () => {
  test('a template button inserts the language words, as Ctrl+Space does', async () => {
    const { EditorView } = await import('@codemirror/view');
    const { markupEntries } = await import('../markupRow/entries');
    services.loadEditorSnippets.mockResolvedValue({ builtIn: [], mine: [], team: [] });
    services.getLocalizedSnippets.mockResolvedValue({
      snippets: [
        {
          id: 'icon-word',
          label: 'Elementsymbol und Wort',
          keywords: '',
          template: '<{{1:solar}} {{2:Solar}} />',
          enHash: 'x',
          language: 'de',
          hint: null,
          outdated: false,
        },
        {
          id: 'editor-note',
          label: 'Notiz',
          keywords: '',
          template: '// {{1:Notiz}}',
          enHash: 'x',
          language: 'de',
          hint: null,
          outdated: false,
        },
      ],
      outdated: [],
      canManage: false,
    });
    await loadSnippetCatalogue('3:translator', 'de');
    const view = new EditorView({ state: state('', 'de'), parent: document.body });
    const note = markupEntries(enhanced).find((entry) => entry.id === 'editor-note')!;
    expect(note.run(view, enhanced)).toBe('inserted');
    expect(view.state.doc.toString()).toBe('// Notiz');
    view.destroy();
  });
});

describe('catalogue reads after changes', () => {
  const deferred = () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  const answer = (label: string) => ({
    builtIn: [],
    mine: [{ id: 'me:x', label, template: 'x' }],
    team: [],
  });

  test('an older read that answers last never replaces a newer one', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    services.loadEditorSnippets
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const initial = loadSnippetCatalogue('4:editor', 'en');
    invalidateSnippetCatalogue(); // save A: read A
    invalidateSnippetCatalogue(); // save B: read B
    third.resolve(answer('After B'));
    await Promise.resolve();
    second.resolve(answer('After A'));
    first.resolve(answer('Before'));
    await initial;
    await new Promise((done) => setTimeout(done));
    expect(snippetCatalogue('en').mine.map((found) => found.snippet.label)).toEqual(['After B']);
  });

  test('a save while the first read is pending reads again', async () => {
    const first = deferred();
    services.loadEditorSnippets
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(answer('Saved'));
    void loadSnippetCatalogue('5:editor', 'en');
    invalidateSnippetCatalogue();
    first.resolve(answer('Stale'));
    await new Promise((done) => setTimeout(done));
    expect(snippetCatalogue('en').mine.map((found) => found.snippet.label)).toEqual(['Saved']);
  });
});
