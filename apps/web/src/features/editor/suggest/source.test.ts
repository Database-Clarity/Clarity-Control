// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { MarkupGlobals } from '@clarity/core';
import { fuzzyScore, suggestContext, suggestItems, type SuggestItem } from './source';
import { recentSuggestions, rememberSuggestion, resetRecentCache } from './recent';
import { corpusUsage } from './usage';

const globals: MarkupGlobals = {
  variables: 'var damage = 25',
  titles: 'title G_refill (\nRefills the magazine.\n)',
};

function at(doc: string, anchor = doc.length, head = anchor) {
  return EditorState.create({ doc, selection: { anchor, head } });
}
function menu(doc: string, explicit = true, anchor?: number, head?: number, recent: string[] = []) {
  const state = at(doc, anchor, head);
  const context = suggestContext(state, explicit);
  return context ? { context, items: suggestItems(context, state, globals, recent) } : null;
}
const labels = (items: SuggestItem[], category?: string) =>
  items.filter((item) => !category || item.category === category).map((item) => item.label);

describe('what the menu would replace', () => {
  test.each([
    ['<so', 'tag', 'so', 0],
    ['Gains #da', 'variable', 'da', 'Gains '.length],
    ['<title More [De', 'title-name', 'De', '<title More ['.length],
    ['import ', 'import-name', '', 'import '.length],
    ['import main from 4', 'import-source', '4', 'import main from '.length],
  ])('%s is a %s context', (doc, kind, query, from) => {
    const found = menu(doc, false)!;
    expect(found.context).toMatchObject({ kind, query, from });
  });
  test('a bare word only opens on request', () => {
    expect(menu('Gains sta', false)).toBeNull();
    expect(menu('Gains sta', true)?.context).toMatchObject({ kind: 'word', query: 'sta' });
  });
  test('a selection only opens on request and is what gets replaced', () => {
    expect(menu('6.5 [5]', false, 0, 7)).toBeNull();
    expect(menu('6.5 [5]', true, 0, 7)?.context).toMatchObject({
      kind: 'selection',
      from: 0,
      to: 7,
      selection: '6.5 [5]',
    });
  });
});

describe('options', () => {
  test('typed globals come from the document and the globals, by name', () => {
    expect(labels(menu('var local = 1\n#lo', false)!.items)).toContain('#local');
    expect(labels(menu('#da', false)!.items)).toContain('#damage');
    expect(labels(menu('<title More [Re', false)!.items)).toContain('G_refill');
  });

  test('"<pv" offers separate PvE and PvP tags next to the pair preset', () => {
    const found = menu('<pv', false)!;
    expect(labels(found.items, 'Tags')).toEqual(expect.arrayContaining(['<pve />', '<pvp />']));
    expect(labels(found.items, 'Snippets')).toContain('PvE and PvP values');
    expect(found.items[0]!.category).toBe('Tags');
  });

  test('no option anywhere offers a table', () => {
    const all = menu('', true)!.items;
    expect(all.length).toBeGreaterThan(30);
    for (const item of all)
      expect(`${item.id} ${item.label} ${item.insert}`).not.toMatch(/table|<\$>/i);
  });

  test('the enhanced section is offered on a free line and carries the enhanced arrow', () => {
    const free = menu('enh', true)!;
    const block = free.items.find((item) => item.id === 'snippet:enhanced-block')!;
    expect(block.insert).toContain('\n#e ');
    expect(block.preview).toContain('enhanced (');
    // Not in the middle of a sentence, where a multi-line declaration cannot go.
    expect(
      menu('Gains enh', true)!.items.some((item) => item.id === 'snippet:enhanced-block'),
    ).toBe(false);
  });

  test('a selection lists Transforms first, then snippets that wrap or take it as a value', () => {
    const found = menu('6.5 [5]', true, 0, 7)!;
    expect(found.items[0]).toMatchObject({
      category: 'Transforms',
      insert: '<pve 6.5 /> <pvp [5] />',
      from: 0,
      to: 7,
    });
    const categories = [...new Set(found.items.map((item) => item.category))];
    expect(categories[0]).toBe('Transforms');
    expect(found.items.find((item) => item.id === 'tag:yellow')!.insert).toBe('<yellow 6.5 [5] />');
    // Block declarations and Globals do not apply to a selection.
    expect(categories).not.toContain('Globals');
    expect(found.items.some((item) => item.id === 'snippet:decl-var')).toBe(false);
  });

  test('"XX [YY]" with the owner example becomes the PvE/PvP pair', () => {
    const found = menu('XX [YY]', true, 0, 7)!;
    // Not numeric, so there is no transform; the pair snippet still takes it as its first value.
    expect(found.items.some((item) => item.category === 'Transforms')).toBe(false);
    expect(found.items.find((item) => item.id === 'snippet:pair')!.insert).toBe(
      '<pve XX [YY] /> <pvp [value] />',
    );
  });

  test('an icon goes in front of a selection without replacing it; an element icon tags it', () => {
    const found = menu('Solar', true, 0, 5)!;
    const icon = found.items.find((item) => item.id === 'icon:primary')!;
    expect(icon).toMatchObject({ from: 0, to: 0, insert: '<primary/>' });
    expect(found.items.find((item) => item.id === 'icon:solar')).toMatchObject({
      from: 0,
      to: 5,
      insert: '<solar Solar />',
      hint: 'wrap',
    });
    expect(found.items.find((item) => item.id === 'transform:element-icon')!.insert).toBe(
      '<solar/>Solar',
    );
    // The element wraps come before the tags (shown without scrolling), and lead the symbols;
    // Enter still takes what it took before (the first transform or snippet).
    const ids = found.items.map((item) => item.id);
    const firstWrap = found.items.findIndex((item) => item.wrap);
    expect(firstWrap).toBeLessThan(ids.findIndex((id) => id.startsWith('tag:')));
    expect(firstWrap).toBeLessThan(ids.indexOf('icon:primary'));
    expect(found.items[0].wrap).toBeFalsy();
  });

  test('each option previews the line as it will read, with its insert applied', () => {
    const found = menu('Reload speed <pv', false)!;
    const tag = found.items.find((item) => item.id === 'tag:pve')!;
    expect(tag.preview).toBe('Reload speed <pve value />');
    // A declaration shows nothing, so it has no rendered preview.
    expect(
      menu('var', true)!.items.find((item) => item.id === 'snippet:decl-var')!.preview,
    ).toBeNull();
  });

  test('every option that counts uses has a usage pattern', () => {
    const all = menu('', true)!.items.filter((item) => item.category !== 'Globals');
    for (const item of all) expect(item.usage, item.id).toBeInstanceOf(RegExp);
  });
});

describe('ranking', () => {
  test('prefix beats word start beats substring beats subsequence', () => {
    const scores = ['pve', 'a pve', 'xpve', 'pxvxe'].map((text) => fuzzyScore(text, 'pve')!);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(fuzzyScore('solar', 'sx')).toBeNull();
    expect(fuzzyScore('anything', '')).toBe(0);
  });

  test('document variables and global variables are separate categories', () => {
    const doc = 'var local = 5' + String.fromCharCode(10) + 'Gains #';
    const state = at(doc, doc.length);
    const context = suggestContext(state, true)!;
    const items = suggestItems(context, state, globals);
    const variables = items
      .filter((item) => item.category === 'Variables')
      .map((item) => item.label);
    const global = items.filter((item) => item.category === 'Globals').map((item) => item.label);
    expect(variables).toEqual(['#local']);
    expect(global).toContain('#damage');
    expect(global).not.toContain('#local');
    expect(items.findIndex((item) => item.category === 'Variables')).toBeLessThan(
      items.findIndex((item) => item.category === 'Globals'),
    );
  });

  test('the retired markup options are not suggested, but still parse', () => {
    const ids = menu('', true)!.items.map((item) => item.id);
    for (const id of [
      'snippet:stack-list',
      'snippet:decl-catalyst',
      'snippet:decl-exotic-perk',
      'style:center',
      'style:background',
      'style:breakSpaces',
      'tag:center',
      'tag:background',
      'tag:blue',
      'tag:green',
      'tag:purple',
    ])
      expect(ids, id).not.toContain(id);
    expect(ids).toEqual(expect.arrayContaining(['style:bold', 'tag:yellow', 'tag:bold']));
  });

  test('recently used options come first when nothing is typed', () => {
    const fresh = menu('', true)!.items.filter((item) => item.category === 'Snippets');
    const pinned = menu('', true, undefined, undefined, ['snippet:pvp-override'])!.items.filter(
      (item) => item.category === 'Snippets',
    );
    expect(fresh[0]!.id).not.toBe('snippet:pvp-override');
    expect(pinned[0]!.id).toBe('snippet:pvp-override');
  });

  test('the category holding the best match leads when something is typed', () => {
    expect(menu('<sol', false)!.items[0]!.category).toBe('Symbols');
    expect(menu('<ye', false)!.items[0]!.category).toBe('Tags');
  });
});

describe('recents and usage', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    resetRecentCache();
  });
  afterEach(() => vi.unstubAllGlobals());
  test('recents persist per device, newest first, without duplicates, and survive bad data', () => {
    rememberSuggestion('a');
    rememberSuggestion('b');
    rememberSuggestion('a');
    expect(recentSuggestions()).toEqual(['a', 'b']);
    resetRecentCache();
    expect(recentSuggestions()).toEqual(['a', 'b']);
    localStorage.setItem('clarity-suggest-recent:v1', '{"nope":1}');
    resetRecentCache();
    expect(recentSuggestions()).toEqual([]);
  });

  test('usage counts tooltips (not occurrences) from saved English text, once per pattern', () => {
    const tooltip = (en?: string) =>
      ({ text: en === undefined ? {} : { en: { text: en } } }) as never;
    const corpus = corpusUsage({
      '1': tooltip('<pve 1 /> <pvp [2] /> and <pve 3 /> <pvp [4] />'),
      '2': tooltip('<pve 5 />'),
      '3': tooltip(),
    });
    expect(corpus.size).toBe(2);
    expect(corpus.count(/<pve /g)).toBe(2);
    expect(corpus.count(/<pve [^<>]*\/>\s*<pvp /)).toBe(1);
    expect(corpus.count(/<pve /g)).toBe(2);
  });
});
