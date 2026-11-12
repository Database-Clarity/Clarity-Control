// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  markupSnippets,
  markupSymbols,
  markupTags,
  markupTransforms,
  type MarkupGlobals,
} from '@clarity/core';
import { insertionRejection } from '../markupInsertion';
import {
  judgeItems,
  nextCategoryIndex,
  requestItems,
  suggestContext,
  suggestItems,
  unavailableReasons,
  type ContextKind,
} from './source';
import {
  acceptSuggestion,
  judgeSuggestions,
  moveSuggest,
  openSuggest,
  suggestConfiguration,
  suggestExtension,
  suggestState,
} from './state';

const globals: MarkupGlobals & { allowBaseEnhanced: boolean } = {
  allowBaseEnhanced: true,
  variables: 'var damage = 25',
  titles: 'title G_refill (\nRefills the magazine.\n)',
};

/** One document per context kind; `|` is the caret, `[`…`]` in the tuple a selection. */
const contexts: [ContextKind, string, number?, number?][] = [
  ['word', 'var local = 1\nGains '],
  ['tag', 'var local = 1\nGains <'],
  ['variable', 'var local = 1\nGains #'],
  ['title-name', 'var local = 1\n<title More ['],
  ['import-name', 'var local = 1\nimport '],
  ['import-source', 'var local = 1\nimport main from '],
  ['selection', 'var local = 1\n6.5 [5]', 14, 21],
];

function stateAt(doc: string, anchor = doc.length, head = anchor) {
  return EditorState.create({ doc, selection: { anchor, head } });
}
function requested(doc: string, anchor?: number, head?: number) {
  const state = stateAt(doc, anchor, head);
  const context = suggestContext(state, true)!;
  const listed = requestItems(context, state, globals);
  return { state, context, items: judgeItems(listed, context, state, globals) };
}

/** Every option the registry holds. The Format wraps and the PvE/PvP snippets are the same markup as a tag, which lists them. */
const registry = [
  ...markupTransforms.map((transform) => `transform:${transform.id}`),
  ...markupTags.map((tag) => tag.id),
  ...markupSymbols.map((symbol) => symbol.id),
  ...markupSnippets.map((snippet) =>
    snippet.group === 'Format'
      ? `tag:${snippet.id.replace('wrap:', '')}`
      : snippet.id === 'pve' || snippet.id === 'pvp'
        ? `tag:${snippet.id}`
        : `snippet:${snippet.id}`,
  ),
];

describe('the menu opened on request', () => {
  test.each(contexts)(
    'lists every registry option, variable and global in a %s context',
    (kind, doc, anchor, head) => {
      const { context, items } = requested(doc, anchor, head);
      expect(context.kind).toBe(kind);
      const ids = items.map((item) => item.id);
      for (const id of registry) expect(ids, id).toContain(id);
      expect(ids).toEqual(expect.arrayContaining(['var:local', 'var:damage']));
      expect(ids.some((id) => id === 'ref:G_refill' || id === 'title:G_refill')).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(`${ids.join(' ')}`).not.toMatch(/table|center|background|purple|blue|green|catalyst/);
    },
  );

  test.each(contexts)(
    'pins what the %s context offered before, in the same order, above the rest',
    (_kind, doc, anchor, head) => {
      const { state, context, items } = requested(doc, anchor, head);
      const before = suggestItems(context, state, globals);
      const pinned = items.filter((item) => item.pinned);
      expect(pinned.map((item) => item.id)).toEqual(before.map((item) => item.id));
      // What a pinned option writes is what it always wrote.
      expect(pinned.map(({ from, to, insert, stops }) => ({ from, to, insert, stops }))).toEqual(
        before.map(({ from, to, insert, stops }) => ({ from, to, insert, stops })),
      );
      expect(items.slice(0, pinned.length).every((item) => item.pinned)).toBe(true);
      expect(items.slice(pinned.length).some((item) => item.pinned)).toBe(false);
    },
  );

  test('the rest keeps one order whatever the context', () => {
    const order = (doc: string) => {
      const ranks = requested(doc)
        .items.filter((item) => !item.pinned)
        .map((item) => item.id);
      return ranks;
    };
    const everything = requested('var local = 1\n<title More [').items.filter(
      (item) => !item.pinned,
    );
    const position = new Map(everything.map((item, index) => [item.id, index]));
    for (const doc of ['Gains #', 'Gains <', 'import ']) {
      const known = order(doc)
        .map((id) => position.get(id))
        .filter((at) => at !== undefined);
      expect(known).toEqual([...known].sort((a, b) => a! - b!));
    }
  });

  test('typing filters both parts, pinned matches first', () => {
    const { items } = requested('Gains #da');
    expect(items[0]).toMatchObject({ id: 'var:damage', pinned: true });
    // Nothing in "hunter icon" spells d…a, so it is filtered out of the rest as well.
    expect(items.map((item) => item.id)).not.toContain('icon:hunter');
    expect(items.length).toBeLessThan(requested('Gains #').items.length);
  });

  test('an option the insertion rules decline is listed with the reason, never offered as fine', () => {
    // A line holding a variable reference is protected: nothing new may go on it.
    const { state, items } = requested('Gains #damage ');
    for (const item of items) {
      if (item.reference || item.unavailable) continue;
      expect(
        insertionRejection(state, item, globals, {
          typed: true,
          link: item.link,
          lineStyle: item.lineStyle,
        }),
        item.id,
      ).toBeNull();
    }
    expect(items.find((item) => item.id === 'tag:pve')!.unavailable).toBe(
      unavailableReasons.context,
    );
    // A declaration needs its own line; a transform needs a selection it fits.
    const mid = requested('Gains ').items;
    expect(mid.find((item) => item.id === 'snippet:decl-var')!.unavailable).toBe(
      unavailableReasons.line,
    );
    expect(mid.find((item) => item.id === 'transform:pair')!.unavailable).toBe(
      unavailableReasons.noSelection,
    );
    const picked = requested('6.5 [5]', 0, 7).items;
    expect(picked.find((item) => item.id === 'transform:pair')!.unavailable).toBeUndefined();
    expect(picked.find((item) => item.id === 'transform:element-icon')!.unavailable).toBe(
      unavailableReasons.noFit,
    );
  });

  test('Ctrl+Space again steps from the pinned options into the rest', () => {
    const { items } = requested('Gains #');
    const firstRest = items.findIndex((item) => !item.pinned);
    let index = 0;
    const seen = [index];
    while (index < firstRest) seen.push((index = nextCategoryIndex(items, index)));
    expect(seen).toContain(firstRest);
  });
});

describe('the menu in the editor', () => {
  function editor(doc: string, host: MarkupGlobals = globals) {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [suggestExtension(), suggestConfiguration({ globals: host })],
      }),
    });
    return view;
  }
  const type = (view: EditorView, text: string) => {
    const at = view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: 'input.type',
    });
  };

  test('the menu that opens while typing is unchanged: only what fits, nothing pinned or greyed', () => {
    for (const [doc, trigger] of [
      ['Gains ', '<'],
      ['Gains ', '#'],
      ['var local = 1\nGains ', '#'],
      ['<title More ', '['],
      ['Gains #damage ', '<'],
    ] as const) {
      const view = editor(doc);
      type(view, trigger);
      const snapshot = suggestState(view.state)!;
      const expected = suggestItems(suggestContext(view.state, false)!, view.state, globals);
      expect(snapshot.explicit).toBe(false);
      expect(snapshot.items).toEqual(expected);
      expect(snapshot.items.some((item) => item.pinned || item.unavailable)).toBe(false);
      view.destroy();
    }
  });

  test('on request the first pinned option is selected; Enter on a greyed option changes nothing', () => {
    const view = editor('Gains #damage ');
    openSuggest(view);
    const snapshot = suggestState(view.state)!;
    expect(snapshot.explicit).toBe(true);
    expect(snapshot.index).toBe(0);
    expect(snapshot.items[0]!.pinned).toBe(true);
    const greyed = snapshot.items.findIndex((item) => item.id === 'transform:pair');
    expect(acceptSuggestion(view, greyed)).toBe('unavailable');
    expect(view.state.doc.toString()).toBe('Gains #damage ');
    expect(suggestState(view.state)!.message).toBe(unavailableReasons.noSelection);
    view.destroy();
  });

  test('the menu shows before the insertion rules are asked; Enter is held to them either way', () => {
    const view = editor('Gains #damage ');
    openSuggest(view);
    const shown = suggestState(view.state)!;
    const tag = shown.items.findIndex((item) => item.id === 'tag:pve');
    expect(shown.judged).toBe(false);
    expect(shown.items[tag]!.unavailable).toBeUndefined();
    // Not judged yet, and Enter still inserts nothing the rules decline.
    expect(acceptSuggestion(view, tag)).toBe('context');
    expect(view.state.doc.toString()).toBe('Gains #damage ');
    expect(suggestState(view.state)!.message).toBe(unavailableReasons.context);
    judgeSuggestions(view);
    const judged = suggestState(view.state)!;
    expect(judged.judged).toBe(true);
    // Nothing pinned fits on this line, so the pinned part is gone and the list reorders.
    const judgedTag = judged.items.findIndex((item) => item.id === 'tag:pve');
    expect(judged.items[judgedTag]!.unavailable).toBe(unavailableReasons.context);
    expect(acceptSuggestion(view, judgedTag)).toBe('unavailable');
    expect(view.state.doc.toString()).toBe('Gains #damage ');
    view.destroy();
  });

  test('asked for beside a word nothing matches, the whole list opens and inserts at the caret', () => {
    const view = editor('Reload qqqq');
    openSuggest(view);
    const snapshot = suggestState(view.state)!;
    expect(snapshot.context).toMatchObject({ query: '', from: 11, to: 11 });
    const icon = snapshot.items.findIndex((item) => item.id === 'icon:solar');
    expect(acceptSuggestion(view, icon)).toBe('inserted');
    expect(view.state.doc.toString()).toBe('Reload qqqq<solar/>');
    view.destroy();
  });

  /** The menu on request at `at`, after the insertion rules have been asked. */
  function judgedAt(doc: string, at: number, host?: MarkupGlobals) {
    const view = editor(doc, host);
    view.dispatch({ selection: { anchor: at } });
    openSuggest(view);
    const shown = suggestState(view.state)!;
    judgeSuggestions(view);
    return { view, shown, judged: suggestState(view.state)! };
  }
  const inTag = 'Gains <pvp [5] /> speed';

  test('where nothing fits (inside a tag) there is no pinned part, only the full list, greyed with reasons', () => {
    const { view, shown, judged } = judgedAt(inTag, inTag.indexOf('[5]'));
    expect(shown.items[0]!.pinned).toBe(true);
    expect(judged.items.some((item) => item.pinned)).toBe(false);
    // The same options as before, now in the fixed order of the rest of the list.
    expect(judged.items.map((item) => item.id).sort()).toEqual(
      shown.items.map((item) => item.id).sort(),
    );
    const categories = judged.items.map((item) => item.category);
    const order = ['Transforms', 'Snippets', 'Tags', 'Symbols', 'Variables', 'Globals'];
    expect(categories).toEqual([...categories].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(judged.items.find((item) => item.id === 'tag:pve')!.unavailable).toBe(
      unavailableReasons.context,
    );
    view.destroy();
  });

  test('with one pinned option that fits, the pinned part stays as built, greyed pins included', () => {
    // A line holding a variable reference: of the options matching "da" only the variable fits.
    const doc = 'Gains #damage da';
    const { view, shown, judged } = judgedAt(doc, doc.length);
    const pins = judged.items.filter((item) => item.pinned);
    expect(pins.filter((item) => !item.unavailable).map((item) => item.id)).toEqual(['var:damage']);
    expect(pins.some((item) => item.unavailable)).toBe(true);
    expect(judged.items.map((item) => item.id)).toEqual(shown.items.map((item) => item.id));
    expect(judged.index).toBe(0);
    view.destroy();
  });

  test('the selection starts on the first option that fits; with none, on the first row, where Enter changes nothing', () => {
    // Inside a tag nothing goes in but the fallbacks a later judge never declines.
    const inside = judgedAt(inTag, inTag.indexOf('[5]'));
    const fits = inside.judged.items.findIndex((item) => !item.unavailable);
    expect(fits).toBeGreaterThan(0);
    expect(inside.judged.index).toBe(fits);
    inside.view.destroy();
    // Inside a tag with no variables or globals to refer to, nothing can go in: the first row, and
    // Enter leaves the text alone.
    const bare = 'Gains <pvp [5] /> speed';
    const none = judgedAt(bare, bare.indexOf('[5]'), { variables: '', titles: '' });
    expect(none.judged.items.length).toBeGreaterThan(0);
    expect(none.judged.items.every((item) => item.unavailable)).toBe(true);
    expect(none.judged.items.some((item) => item.pinned)).toBe(false);
    expect(none.judged.index).toBe(0);
    expect(acceptSuggestion(none.view)).toBe('unavailable');
    expect(none.view.state.doc.toString()).toBe(bare);
    none.view.destroy();
  });

  test('a selection not yet moved leaves a greyed option for the first that fits, with or without pins', () => {
    // No pinned part: inside a title reference only the variable fits.
    const noPins = judgedAt('<title More [ />', '<title More ['.length, {
      variables: 'var damage = 25',
      titles: '',
    });
    expect(noPins.judged.items.some((item) => item.pinned)).toBe(false);
    expect(noPins.judged.items[noPins.judged.index]!.unavailable).toBeUndefined();
    expect(noPins.judged.index).toBe(noPins.judged.items.findIndex((item) => !item.unavailable));
    noPins.view.destroy();
    // A pinned part whose first option is declined and a later one fits.
    const doc = 'Gains #damage so';
    const later = judgedAt(doc, doc.length, {
      variables: 'var someVeryLongVariableName = solar damage',
      titles: '',
    });
    const fits = later.judged.items.findIndex((item) => !item.unavailable);
    expect(later.judged.items[fits]!.pinned).toBe(true);
    expect(later.judged.index).toBe(fits);
    later.view.destroy();
    // A selection the author moved stays where it is, greyed or not.
    const moved = editor('Gains #damage ');
    openSuggest(moved);
    moveSuggest(moved, 1);
    const picked = suggestState(moved.state)!.items[1]!.id;
    judgeSuggestions(moved);
    const after = suggestState(moved.state)!;
    expect(after.items[after.index]!.id).toBe(picked);
    moved.destroy();
  });

  test('a read-only editor has no menu', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'Gains ',
        extensions: [
          suggestExtension(),
          suggestConfiguration({ globals }),
          EditorState.readOnly.of(true),
        ],
      }),
    });
    openSuggest(view);
    expect(suggestState(view.state)).toBeNull();
    view.destroy();
  });
});
