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
  nextCategoryIndex,
  requestItems,
  suggestContext,
  suggestItems,
  unavailableReasons,
  type ContextKind,
} from './source';
import {
  acceptSuggestion,
  openSuggest,
  suggestConfiguration,
  suggestExtension,
  suggestState,
} from './state';

const globals: MarkupGlobals = {
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
  return { state, context, items: requestItems(context, state, globals) };
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
  function editor(doc: string) {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [suggestExtension(), suggestConfiguration({ globals })],
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
