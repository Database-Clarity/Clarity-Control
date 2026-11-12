import { offersBaseEnhanced } from '../markupScope';
import type { EditorState } from '@codemirror/state';
import {
  applicableTransforms,
  expandSnippet,
  expandTemplate,
  extractBlocks,
  extractVariables,
  markupSnippets,
  markupSymbols,
  markupTags,
  markupTransforms,
  type ExpandedTemplate,
  type MarkupGlobals,
  type Snippet,
} from '@clarity/core';
import { insertionChecker, type Rejection } from '../markupInsertion';
import { elementLabel, isElementName, tagSelection, wrapChange } from '../elementTags';
import { locateBlocks, locateVariables } from '../references';
import { englishSymbols, subclassSymbol } from './typedSymbols';

export type SuggestCategory =
  'Transforms' | 'Snippets' | 'Tags' | 'Symbols' | 'Variables' | 'Globals';

export type ContextKind =
  'selection' | 'tag' | 'variable' | 'title-name' | 'import-source' | 'import-name' | 'word';

export interface SuggestContext {
  kind: ContextKind;
  /** The text the menu replaces: the selection, or the trigger and the word typed after it. */
  from: number;
  to: number;
  /** What the author has typed after the trigger; filters the options. */
  query: string;
  /** The selected text (empty unless kind is 'selection'). */
  selection: string;
  /** The whole line(s) the range sits on, for the rendered preview. */
  lineFrom: number;
  lineText: string;
  /** Variable and title definitions in the document, so a preview resolves local references. */
  definitions: string;
  /** Nothing but the typed trigger is on this line, so multi-line declarations may go here. */
  lineIsFree: boolean;
  /**
   * Asked for beside a word no option matched: the menu sits at the caret (`from`), and what is
   * typed from there on is the query, not the word before it.
   */
  atCaret?: boolean;
  /** A catalogue subclass name: retain it when a matching symbol is chosen. Null means no known element. */
  subclassIcon?: string | null;
}

export interface SuggestItem {
  id: string;
  category: SuggestCategory;
  label: string;
  /** Short grey text after the label (a value, a source). */
  hint?: string;
  about: string;
  /** What lands in the document, replacing `from`..`to` (absolute positions). */
  from: number;
  to: number;
  insert: string;
  /** Tab stops as offsets into `insert`; empty means the caret ends after the text. */
  stops: ExpandedTemplate['stops'];
  /** Markup the detail pane renders: the line as it will read, or null when nothing shows. */
  preview: string | null;
  /** Counts uses across the corpus; absent when a count would mean nothing. */
  usage?: RegExp;
  /** A reference to something already defined: the markup-safety rules do not apply. */
  reference?: boolean;
  /** An element-tag wrap of the selection, already judged by the wrap rules (elementTags.ts). */
  wrap?: boolean;
  /** Link-like text must not land in a legacy table cell. */
  link?: boolean;
  /** A whole-line style marker: the line may only carry as many as it can show. */
  lineStyle?: string;
  /** Fuzzy haystack beyond the label. */
  keys: string;
  /** In the on-request menu: one of the options this spot calls for, listed above the rest. */
  pinned?: boolean;
  /** In the on-request menu: why this option cannot go here. It stays listed; Enter leaves the text alone. */
  unavailable?: string;
}

/** The short reason an option shows when it cannot go at the caret. */
export const unavailableReasons = {
  context: 'Cannot go inside this markup.',
  expansion: 'An import or variable here may change the markup.',
  'table-link': 'Links cannot go in table cells.',
  'line-style': 'This line already has that style.',
  line: 'Needs an empty line.',
  noSelection: 'Select the text to transform first.',
  noFit: 'Does not fit the selected text.',
} as const satisfies Record<Rejection | 'line' | 'noSelection' | 'noFit', string>;

const triggers = {
  variable: /#[a-zA-Z0-9]*$/,
  title: /(?<=<title .*\[)[A-Za-z0-9_ ]*$/,
  importSource: /(?<=^import .+ from )[a-zA-Z0-9]*$/,
  importName: /(?<=^import )[A-Za-z0-9 ]*$/,
  tag: /<[a-zA-Z]*$/,
  word: /\w*$/,
};

/** The definitions of each document still in use: a menu reopened on the same text reads nothing twice. */
const definitions = new WeakMap<object, string>();
function stateDefinitions(state: EditorState): string {
  let found = definitions.get(state.doc);
  if (found === undefined) {
    found = documentDefinitions(state.doc.toString());
    definitions.set(state.doc, found);
  }
  return found;
}

export function documentDefinitions(text: string): string {
  return [
    ...[...locateVariables(text).values()].map((found) => found.raw),
    ...[...locateBlocks(text, 'title').values()].map((found) => found.raw),
  ].join('\n');
}

/** What the menu would replace at the caret/selection, or null when there is no trigger. */
export function suggestContext(state: EditorState, explicit: boolean): SuggestContext | null {
  const main = state.selection.main;
  const doc = state.doc;
  const firstLine = doc.lineAt(main.from);
  const lastLine = doc.lineAt(main.to);
  const base = {
    lineFrom: firstLine.from,
    lineText: doc.sliceString(firstLine.from, lastLine.to),
    definitions: stateDefinitions(state),
  };
  if (!main.empty) {
    // A selection only opens the menu on request; typing replaces it like any selection.
    if (!explicit) return null;
    return {
      ...base,
      kind: 'selection',
      from: main.from,
      to: main.to,
      query: '',
      selection: doc.sliceString(main.from, main.to),
      lineIsFree: false,
    };
  }
  const before = doc.sliceString(firstLine.from, main.head);
  const found = (kind: ContextKind, pattern: RegExp): SuggestContext | null => {
    const match = before.match(pattern);
    if (!match) return null;
    const from = main.head - match[0].length;
    return {
      ...base,
      kind,
      from,
      to: main.head,
      query: match[0].replace(/^[<#]/, ''),
      selection: '',
      lineIsFree:
        doc.sliceString(firstLine.from, from).trim() === '' &&
        doc.sliceString(main.head, firstLine.to).trim() === '',
    };
  };
  const context =
    found('variable', triggers.variable) ??
    found('title-name', triggers.title) ??
    found('import-source', triggers.importSource) ??
    found('import-name', triggers.importName) ??
    found('tag', triggers.tag) ??
    (explicit ? found('word', triggers.word) : null);
  if (context?.kind === 'word' && englishSymbols(state)) {
    const subclass = subclassSymbol(before, context.query);
    if (subclass)
      return {
        ...context,
        from: main.head - subclass.word.length,
        query: subclass.word,
        subclassIcon: subclass.icon,
      };
  }
  return context;
}

/** A positive score for a match (higher is better), null for none, 0 for an empty query. */
export function fuzzyScore(haystack: string, query: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const h = haystack.toLowerCase();
  if (h.startsWith(q)) return 100 - Math.min(h.length, 40) / 4;
  const word = h.search(new RegExp(`[\\s<#\\[(/_-]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  if (word >= 0) return 85 - Math.min(word, 30) / 3;
  const at = h.indexOf(q);
  if (at >= 0) return 70 - Math.min(at, 30) / 3;
  // Subsequence: every query letter in order; tighter and earlier is better.
  let position = -1;
  let gaps = 0;
  for (const letter of q) {
    const next = h.indexOf(letter, position + 1);
    if (next < 0) return null;
    if (position >= 0) gaps += next - position - 1;
    position = next;
  }
  return Math.max(1, 55 - gaps - position / 4);
}

const snippetOf = (entry: {
  template: string;
  keywords: string;
  usage: RegExp;
  about: string;
  id: string;
  label: string;
}): Snippet => ({
  group: 'Format',
  wraps: true,
  ...entry,
});

/** The truncated single line a variable's value shows in the list. */
const shorten = (value: string, length = 28) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

export function suggestItems(
  context: SuggestContext,
  state: EditorState,
  globals: MarkupGlobals,
  recent: readonly string[] = [],
): SuggestItem[] {
  return rank(build(context, state, globals, false), context, recent);
}

/**
 * The options at a caret. Normally only what the context calls for; with `every`, the whole
 * registry plus every variable and title, whatever the context, in a fixed order. An option that
 * has nowhere to go here (a declaration in the middle of a line, a transform that does not fit) is
 * then still listed, marked unavailable.
 */
/** What the options need from the text and the globals, read once per document state. */
function documentFacts(state: EditorState, globals: MarkupGlobals) {
  const cached = facts.get(state.doc);
  if (cached?.globals === globals) return cached;
  const text = state.doc.toString();
  const documentVariables = extractVariables(text);
  const titles = { ...extractBlocks(text, 'title'), ...extractBlocks(globals.titles, 'title') };
  const read = {
    globals,
    documentVariables,
    variables: { ...documentVariables, ...extractVariables(globals.variables) },
    titles,
    titleNames: Object.keys(titles),
  };
  facts.set(state.doc, read);
  return read;
}
const facts = new WeakMap<
  object,
  {
    globals: MarkupGlobals;
    documentVariables: Record<string, string>;
    variables: Record<string, string>;
    titles: Record<string, string>;
    titleNames: string[];
  }
>();

function build(
  context: SuggestContext,
  state: EditorState,
  globals: MarkupGlobals,
  every: boolean,
  /** Options already listed (the pinned ones): not built a second time. */
  skip?: ReadonlySet<string>,
): SuggestItem[] {
  const { documentVariables, variables, titles, titleNames } = documentFacts(state, globals);
  const items: SuggestItem[] = [];
  const previewOf = (from: number, to: number, insert: string) =>
    context.lineText.slice(0, from - context.lineFrom) +
    insert +
    context.lineText.slice(to - context.lineFrom);
  const push = (
    partial: Omit<SuggestItem, 'from' | 'to' | 'stops' | 'preview' | 'keys' | 'insert'> & {
      insert: string;
      stops?: SuggestItem['stops'];
      from?: number;
      to?: number;
      /** Rendered text; defaults to the line with the insert applied. */
      preview?: string | null;
      keys?: string;
    },
  ) => {
    const from = partial.from ?? context.from;
    const to = partial.to ?? context.to;
    items.push({
      ...partial,
      from,
      to,
      stops: partial.stops ?? [],
      preview:
        partial.preview === undefined ? previewOf(from, to, partial.insert) : partial.preview,
      keys: partial.keys ?? '',
    });
  };
  const query = context.query;

  /** A variable defined in this tooltip is a document variable; the rest come from the globals. */
  const variableItem = (name: string, value: string) =>
    !skip?.has(`var:${name}`) &&
    push({
      id: `var:${name}`,
      category: name in documentVariables ? 'Variables' : 'Globals',
      label: `#${name}`,
      hint: shorten(value || 'empty'),
      about:
        name in documentVariables
          ? 'A variable defined in this tooltip.'
          : 'A global variable, shared by every tooltip.',
      insert: `#${name}`,
      usage: new RegExp(`#${name}(?![a-zA-Z0-9])`),
      reference: true,
      keys: value,
    });
  const addSnippet = (snippet: Snippet, category: SuggestCategory) => {
    // A multi-line declaration needs a line of its own.
    const id = `${category === 'Tags' ? '' : 'snippet:'}${snippet.id}`;
    if (skip?.has(id)) return;
    const noLine = snippet.block && (!context.lineIsFree || context.kind === 'selection');
    if (noLine && !every) return;
    const expanded = expandSnippet(snippet, noLine ? '' : context.selection);
    if (!every && context.kind === 'selection' && !snippet.wraps && !snippet.fromSelection) return;
    push({
      id,
      category,
      label: snippet.label,
      about: snippet.about,
      insert: expanded.text,
      stops: expanded.stops,
      preview: snippet.group === 'Blocks' || noLine ? null : undefined,
      ...(noLine ? { unavailable: unavailableReasons.line } : {}),
      usage: snippet.usage,
      link: snippet.id === 'link-ref' || snippet.id === 'tag:link',
      keys: snippet.keywords,
    });
  };

  if (context.kind === 'selection' || every) {
    const outputs = new Map(
      applicableTransforms(context.selection, { titles: titleNames }).map((result) => [
        result.transform.id,
        result.output,
      ]),
    );
    for (const transform of markupTransforms) {
      const output = outputs.get(transform.id);
      if ((output === undefined && !every) || skip?.has(`transform:${transform.id}`)) continue;
      push({
        id: `transform:${transform.id}`,
        category: 'Transforms',
        label: transform.label,
        about: transform.about,
        insert: output ?? '',
        ...(output === undefined
          ? {
              preview: null,
              unavailable:
                context.kind === 'selection'
                  ? unavailableReasons.noFit
                  : unavailableReasons.noSelection,
            }
          : {}),
        usage: transform.usage,
        keys: transform.label,
      });
    }
  }

  if (context.kind === 'variable' && !every) {
    for (const [name, value] of Object.entries(variables)) {
      variableItem(name, value);
    }
    addSnippet(
      markupSnippets.find((snippet) => snippet.id === 'enhanced-formula')!,
      'Snippets',
    );
  }

  if (context.kind === 'title-name' && !every) {
    for (const [name, body] of Object.entries(titles)) {
      const before = context.lineText.slice(0, context.from - context.lineFrom);
      push({
        id: `title:${name}`,
        category: 'Globals',
        label: name,
        hint: shorten(body.replace(/\s+/g, ' ')),
        about: 'A title definition in this tooltip or the globals.',
        insert: name,
        preview: `${before}${name}] />`,
        usage: new RegExp(`\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`),
        reference: true,
        keys: body,
      });
    }
  }

  if (context.kind === 'import-source' && !every) {
    const sources = new Set(Object.keys(globals.imports ?? {}));
    if (globals.imports?.['1']) sources.add('global');
    for (const name of sources) {
      push({
        id: `import-source:${name}`,
        category: 'Globals',
        label: name,
        about: name === 'global' ? 'The shared globals export.' : `Tooltip ${name}'s exports.`,
        insert: name,
        preview: null,
        reference: true,
      });
    }
  }

  if (context.kind === 'import-name' && !every) {
    const names = new Set([
      'main',
      ...Object.values(globals.imports ?? {}).flatMap((source) =>
        Object.keys(extractBlocks(source, 'export')),
      ),
    ]);
    for (const name of names) {
      push({
        id: `import-name:${name}`,
        category: 'Globals',
        label: name,
        about: name === 'main' ? 'A whole tooltip text.' : 'A named export.',
        insert: name,
        preview: null,
        reference: true,
      });
    }
  }

  if (every || context.kind === 'selection' || context.kind === 'tag' || context.kind === 'word') {
    const insertAtStart = context.kind === 'selection';
    // A wrappable selection: the element symbols tag it instead (`<solar Scorch />`).
    const wrap = insertAtStart ? tagSelection(state, globals) : undefined;
    for (const symbol of markupSymbols) {
      if (skip?.has(symbol.id)) continue;
      if (wrap?.kind === 'wrap' && isElementName(symbol.name)) {
        const change = wrapChange(state, wrap.from, wrap.to, symbol.name);
        push({
          id: symbol.id,
          category: 'Symbols',
          label: `<${symbol.name} … />`,
          hint: 'wrap',
          about: `Tags the selection as ${elementLabel(symbol.name)}: the icon, then the text in the ${elementLabel(symbol.name)} tint.${change.absorbed ? ' The icon before it joins the tag.' : ''}`,
          insert: change.insert,
          from: change.from,
          to: change.to,
          wrap: true,
          usage: symbol.usage,
          keys: `${symbol.keywords} wrap tag`,
        });
        continue;
      }
      const tag = `<${symbol.name}/>`;
      const keepWord =
        context.kind === 'word' &&
        context.subclassIcon !== undefined &&
        symbol.id.startsWith('icon:') &&
        (context.subclassIcon === null || context.subclassIcon === symbol.name);
      push({
        id: symbol.id,
        category: 'Symbols',
        label: tag,
        ...(symbol.id.startsWith('style:') ? { hint: 'whole line', lineStyle: symbol.name } : {}),
        about: keepWord ? `${symbol.name} symbol before ${query}.` : symbol.about,
        insert: keepWord ? tag + query : tag,
        ...(keepWord ? { hint: `before ${query}` } : {}),
        // With a selection the symbol goes in front of it and the selection stays.
        ...(insertAtStart ? { from: context.from, to: context.from } : {}),
        usage: symbol.usage,
        keys: keepWord ? `${symbol.keywords} ${query}` : symbol.keywords,
      });
    }
    for (const tag of markupTags) addSnippet(snippetOf(tag), 'Tags');
    for (const snippet of markupSnippets) {
      if (snippet.id === 'base-enhanced-pair' && !offersBaseEnhanced(globals)) continue;
      if (snippet.id === 'enhanced-formula' && !every) continue;
      // The Tags category carries the single tags (colours, PvE, PvP).
      if (snippet.group === 'Format' || snippet.id === 'pve' || snippet.id === 'pvp') continue;
      addSnippet(snippet, 'Snippets');
    }
    if (context.kind !== 'selection' || every) {
      // A title reference for each known title whose name matches what was typed.
      if (query || every) {
        for (const name of titleNames) {
          if (skip?.has(`ref:${name}`)) continue;
          // A selection becomes the text that carries the reference.
          const expanded = expandTemplate(`<title {{1:Text}} [${name}] />`, context.selection);
          push({
            id: `ref:${name}`,
            category: 'Globals',
            label: `<title … [${name}] />`,
            about: 'A hover reference to this title.',
            insert: expanded.text,
            stops: expanded.stops,
            usage: new RegExp(`\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`),
            keys: name,
          });
        }
      }
      for (const [name, value] of Object.entries(variables)) {
        if (!query && !every) break;
        variableItem(name, value);
      }
    }
  }

  return items;
}

/** The fixed order of everything below the pinned options: the same every time, so it can be learned. */
const everyOrder: readonly SuggestCategory[] = [
  'Transforms',
  'Snippets',
  'Tags',
  'Symbols',
  'Variables',
  'Globals',
];

/**
 * The on-request menu (Ctrl+Space, the touch Suggest control): every option there is. What the
 * context calls for comes first, exactly as `suggestItems` orders it (so Enter does what it always
 * did); everything else follows by category. A typed query filters both parts. Whether the
 * insertion rules let each option in at this caret is `judgeItems`' job, done once the menu shows.
 */
export function requestItems(
  context: SuggestContext,
  state: EditorState,
  globals: MarkupGlobals,
  recent: readonly string[] = [],
): SuggestItem[] {
  const pinned = suggestItems(context, state, globals, recent);
  const taken = new Set(pinned.map((item) => item.id));
  const others = build(context, state, globals, true, taken).filter(
    (item) => !context.query || matchScore(item, context.query) > 0,
  );
  for (const item of pinned) item.pinned = true;
  return [
    ...pinned,
    ...everyOrder.flatMap((category) => others.filter((item) => item.category === category)),
  ];
}

/**
 * Marks every option the insertion rules decline at this caret with the reason, so it shows as
 * unavailable instead of failing on Enter. This reads the whole document under the markup-safety
 * rules, which is why the menu opens first and asks afterwards. The same array comes back when
 * every option may go in.
 */
export function judgeItems(
  items: SuggestItem[],
  context: SuggestContext,
  state: EditorState,
  globals: MarkupGlobals,
): SuggestItem[] {
  const check = insertionChecker(state, globals);
  const selection = context.kind === 'selection';
  let changed = false;
  const judged = items.map((item) => {
    // A reference to something already defined is not held to the markup-safety rules.
    if (item.unavailable || item.reference || item.wrap) return item;
    const rejection = check(
      { from: item.from, to: item.to },
      { typed: !selection || item.from === item.to, link: item.link, lineStyle: item.lineStyle },
    );
    if (!rejection) return item;
    changed = true;
    return { ...item, unavailable: unavailableReasons[rejection] };
  });
  return changed ? judged : items;
}

/**
 * The on-request list without its pinned part, when the insertion rules decline every pinned
 * option: nothing fits at this caret, so the full list shows directly in its fixed order (greyed
 * options keep their reason). Any other list comes back as it is.
 */
export function dropDeclinedPins(
  items: SuggestItem[],
  context: SuggestContext,
  state: EditorState,
  globals: MarkupGlobals,
): SuggestItem[] {
  if (!items[0]?.pinned || items.some((item) => item.pinned && !item.unavailable)) return items;
  // Where each option sits in the fixed order: its category, then its place in the registry.
  const place = new Map(
    build(context, state, globals, true).map((item, index) => [item.id, index]),
  );
  const rank = (item: SuggestItem) =>
    everyOrder.indexOf(item.category) * 1e6 + (place.get(item.id) ?? 1e6 - 1);
  return items
    .map((item) => (item.pinned ? { ...item, pinned: false } : item))
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * The context of a menu opened on request beside text that matches no option: nothing is replaced
 * and nothing filters, so the whole list shows and an option goes in at the caret.
 */
export function caretContext(
  context: SuggestContext,
  state: EditorState,
  from = state.selection.main.head,
): SuggestContext {
  const head = state.selection.main.head;
  return {
    ...context,
    kind: 'word',
    atCaret: true,
    from,
    to: head,
    query: state.sliceDoc(from, head),
    lineIsFree: state.doc.lineAt(head).text.trim() === '',
  };
}

/** How well an option matches what was typed; zero or less is no match. */
function matchScore(item: SuggestItem, query: string): number {
  return Math.max(
    fuzzyScore(item.label.replace(/[<>/]/g, ''), query) ?? -1,
    (fuzzyScore(item.keys, query) ?? 0) - 15,
  );
}

const defaultOrder: Record<ContextKind, SuggestCategory[]> = {
  selection: ['Transforms', 'Snippets', 'Tags', 'Symbols'],
  tag: ['Tags', 'Symbols', 'Snippets', 'Globals'],
  variable: ['Variables', 'Globals', 'Snippets'],
  'title-name': ['Globals'],
  'import-source': ['Globals'],
  'import-name': ['Globals'],
  word: ['Snippets', 'Tags', 'Symbols', 'Variables', 'Globals'],
};

const wrapOrder: SuggestCategory[] = ['Transforms', 'Snippets', 'Symbols', 'Tags'];

const perCategory = 24;

function rank(
  items: SuggestItem[],
  context: SuggestContext,
  recent: readonly string[],
): SuggestItem[] {
  // A wrappable selection: its element wraps (`<solar Scorch />`) come right after the snippets,
  // above the tags, so they show without scrolling; Enter still takes the first snippet.
  const wraps = context.kind === 'selection' && items.some((item) => item.wrap);
  const order = wraps ? wrapOrder : defaultOrder[context.kind];
  const scored = items.flatMap((item, index) => {
    const score = context.query ? matchScore(item, context.query) : 0;
    if (context.query && score <= 0) return [];
    const recency = recent.indexOf(item.id);
    return [{ item, index, score, recency: recency < 0 ? 99 : recency }];
  });
  const groups = order.map((category) => ({
    category,
    entries: scored
      .filter((entry) => entry.item.category === category)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(!!b.item.wrap) - Number(!!a.item.wrap) ||
          (context.query ? 0 : a.recency - b.recency) ||
          a.index - b.index,
      )
      .slice(0, perCategory),
  }));
  // With a query the category holding the best match leads; the default order breaks ties.
  if (context.query) {
    groups.sort((a, b) => (b.entries[0]?.score ?? -1) - (a.entries[0]?.score ?? -1));
    if (context.kind === 'selection')
      groups.sort(
        (a, b) => Number(b.category === 'Transforms') - Number(a.category === 'Transforms'),
      );
  }
  return groups.flatMap((group) => group.entries.map((entry) => entry.item));
}

/**
 * The index of the first option of the next category, wrapping; used by Ctrl+Space when open. The
 * pinned options and the rest are separate groups even where a category continues across them.
 */
export function nextCategoryIndex(items: readonly SuggestItem[], current: number): number {
  const here = items[current];
  const next = items.findIndex(
    (item, index) =>
      index > current &&
      (item.category !== here?.category || Boolean(item.pinned) !== Boolean(here?.pinned)),
  );
  return next < 0 ? 0 : next;
}
