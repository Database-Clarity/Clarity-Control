// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { Lang, MarkupGlobals } from '@clarity/core';
import { requestItems, suggestContext, suggestItems } from './source';
import { loadSnippetCatalogue, snippetCatalogue, snippetLang } from './custom';

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

  test('ties after score and recency: Mine, then Team, then built-in', () => {
    // The options this spot calls for (a mid-line declaration waits in the full list, as built-ins do).
    const items = requested('x ').filter((item) => item.category === 'Snippets' && item.pinned);
    const sources = items.map((item) => item.source ?? 'built-in');
    expect(sources.indexOf('built-in')).toBeGreaterThan(sources.lastIndexOf('team'));
    expect(sources.lastIndexOf('mine')).toBeLessThan(sources.indexOf('team'));
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

  test('a selection offers Save as snippet', () => {
    const items = requested('Grants Bonus damage', 'en', 7, 19);
    expect(items.find((item) => item.id === 'save-snippet')).toMatchObject({
      saveSnippet: true,
      hint: 'Mine',
    });
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
