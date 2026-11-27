import { offeredHere } from '../markupScope';
import type { EditorState } from '@codemirror/state';
import {
  applicableTransforms,
  enhancedArrowMarkup,
  expandSnippet,
  expandTemplate,
  extractBlocks,
  extractVariables,
  markupSnippets,
  markupSymbols,
  markupTags,
  markupTransforms,
  writeVariable,
  type ElementTagName,
  type ExpandedTemplate,
  type MarkupGlobals,
  type Snippet,
} from '@clarity/core';
import { insertionChecker, type Rejection } from '../markupInsertion';
import {
  checkedNameTag,
  checkedWrap,
  elementLabel,
  isElementName,
  tagSelection,
} from '../elementTags';
import { groupChange, pairAt } from '../iconPairs';
import { locateBlocks, locateVariables } from '../references';
import { englishSymbols, subclassSymbol } from './typedSymbols';
import { numberHost, numbersAllowed, orderedNumbers, usedNumbers } from '../numbers/state';
import { canSaveSnippets, localSnippet, snippetCatalogue, snippetLang } from './custom';
import { offersBaseEnhanced } from '../markupScope';
import { snippetTemplateIssue } from '../../../../../../packages/core/src/customSnippets';
import { suggestionRowOrder } from '../markupRow/order';

export type SuggestCategory =
  | 'Transforms'
  | 'Snippets'
  | 'Tags'
  | 'Symbols'
  | 'Variables'
  | 'Globals'
  | 'Numbers'
  | 'Markup tools';

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
  /** A matched catalogue name, with its canonical spelling and known element. */
  subclass?: NonNullable<ReturnType<typeof subclassSymbol>>;
}

export interface SuggestItem {
  numberId?: number;
  numberPanel?: boolean;
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
  /** The typed name can be replaced by a canonical name inside an element tag. */
  nameTag?: { from: number; element: ElementTagName; name: string };
  /**
   * "Group with icon" on the pair at the caret (iconPairs.ts), judged by its own rules. A spaced
   * pair asks before it drops the space.
   */
  group?: 'joined' | 'spaced';
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
  /** A personal or team snippet: typed matches break score ties Mine, then Team, then built-in. */
  source?: 'mine' | 'team';
  /** "Save as snippet": opens the save form for the selection instead of inserting. */
  saveSnippet?: boolean;
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
  if (
    context?.kind === 'word' &&
    englishSymbols(state) &&
    !/^[\p{L}\p{N}_]/u.test(doc.sliceString(main.head, Math.min(firstLine.to, main.head + 2)))
  ) {
    const subclass = subclassSymbol(before, context.query);
    if (subclass)
      return {
        ...context,
        from: main.head - subclass.word.length,
        query: subclass.word,
        subclass,
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

/**
 * The bare enhanced arrow symbol, written at the caret, never over the selection. Offered (here,
 * the markup bar, and All) only where the arrow is (markupScope); the global `e` behind it is
 * never offered as a variable.
 */
export const enhancedArrowSnippet: Snippet = {
  id: 'enhanced-arrow',
  label: enhancedArrowMarkup,
  group: 'Enhanced',
  template: enhancedArrowMarkup,
  keywords: 'enhanced arrow e gold up',
  usage: /<enhanced\/>|#e(?![a-zA-Z0-9])/,
  about: `The enhanced arrow, written ${enhancedArrowMarkup}.`,
};

/** The truncated single line a variable's value shows in the list. */
const shorten = (value: string, length = 28) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

export function suggestItems(
  context: SuggestContext,
  state: EditorState,
  globals: MarkupGlobals,
  recent: readonly string[] = [],
  /** On request (Ctrl+Space): custom snippets are listed without a query too. */
  explicit = false,
): SuggestItem[] {
  return rank(build(context, state, globals, false, undefined, explicit), context, recent);
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
  explicit = false,
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
  const source = state.facet(numberHost).source;
  if (source && numbersAllowed(state, context.from, context.to)) {
    const { used } = usedNumbers(state);
    const matches = orderedNumbers(state, true)
      .map((id) => source.byId.get(id)!)
      .filter(
        (slot) =>
          (!query && !used.has(slot.id)) ||
          (!!query &&
            `${slot.display} ${slot.context} ${slot.breadcrumb}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      );
    for (const slot of matches.slice(0, 5))
      if (!skip?.has(`number:${slot.id}`))
        push({
          id: `number:${slot.id}`,
          category: 'Numbers',
          label: slot.display,
          numberId: slot.id,
          insert: `#{=${slot.id}}`,
          hint: `${used.has(slot.id) ? 'Used' : 'To do'} · ${slot.context}`,
          about: `${slot.breadcrumb} · #${slot.id}`,
          keys: `${slot.display} ${slot.context} ${slot.breadcrumb}`,
          reference: true,
          preview: null,
        });
    if (matches.length > 5 && !skip?.has('number:more'))
      push({
        id: 'number:more',
        category: 'Numbers',
        label: `${matches.length - 5} more`,
        numberPanel: true,
        insert: '',
        about: 'Open Numbers',
        reference: true,
      });
  }

  /**
   * A variable defined in this tooltip is a document variable; the rest come from the globals.
   * The global `e` is the enhanced arrow: never offered as a variable (`<enhanced/>` is offered
   * where the arrow is, `arrowItem`).
   */
  const variableItem = (name: string, value: string) => {
    if (name === 'e' && !(name in documentVariables)) return;
    if (skip?.has(`var:${name}`)) return;
    push({
      id: `var:${name}`,
      category: name in documentVariables ? 'Variables' : 'Globals',
      label: `#${name}`,
      hint: shorten(value || 'empty'),
      about:
        name in documentVariables
          ? 'A variable defined in this tooltip.'
          : 'A global variable, shared by every tooltip.',
      insert: writeVariable(name),
      usage: new RegExp(`#${name}(?![a-zA-Z0-9])|#\\{${name}\\}`),
      reference: true,
      keys: value,
    });
  };
  const lang = state.facet(snippetLang);
  const catalogue = snippetCatalogue(lang);
  const addSnippet = (
    builtIn: Snippet,
    category: SuggestCategory,
    custom?: { source: 'mine' | 'team'; link: boolean; english: boolean },
  ) => {
    // A multi-line declaration needs a line of its own.
    const id = `${category === 'Tags' ? '' : category === 'Symbols' ? 'icon:' : 'snippet:'}${builtIn.id}`;
    if (skip?.has(id)) return;
    // While translating, built-ins carry the target language's words (English ones say so).
    const local = custom
      ? { snippet: builtIn, english: custom.english }
      : localSnippet(builtIn, catalogue, lang);
    const snippet = local.snippet;
    const noLine = snippet.block && (!context.lineIsFree || context.kind === 'selection');
    if (noLine && !every) return;
    const expanded = expandSnippet(snippet, noLine ? '' : context.selection);
    if (!every && context.kind === 'selection' && !snippet.wraps && !snippet.fromSelection) return;
    const hints = [
      custom ? (custom.source === 'mine' ? 'Mine' : 'Team') : '',
      local.english ? 'EN' : '',
    ].filter(Boolean);
    push({
      id,
      category,
      label: snippet.label,
      ...(hints.length ? { hint: hints.join(' · ') } : {}),
      about: snippet.about,
      insert: expanded.text,
      stops: expanded.stops,
      preview: snippet.group === 'Blocks' || noLine ? null : undefined,
      ...(noLine ? { unavailable: unavailableReasons.line } : {}),
      ...(custom ? { source: custom.source } : { usage: snippet.usage }),
      link: custom ? custom.link : snippet.id === 'link-ref' || snippet.id === 'tag:link',
      keys: custom ? `${snippet.keywords} ${expanded.text}` : snippet.keywords,
    });
  };
  /**
   * Personal, then team snippets, in the Snippets category. The menu that opens while typing lists
   * them only once something typed matches; they follow every rule the built-ins follow.
   */
  const addCustom = () => {
    if (!every && !explicit && !query) return;
    for (const found of [...catalogue.mine, ...catalogue.team]) {
      if (found.enhanced && !offersBaseEnhanced(globals)) continue;
      addSnippet(found.snippet, 'Snippets', found);
    }
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
    if (offeredHere(enhancedArrowSnippet.id, globals)) addSnippet(enhancedArrowSnippet, 'Symbols');
    if (offeredHere('enhanced-formula', globals))
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
      const change =
        wrap?.kind === 'wrap' && isElementName(symbol.name)
          ? checkedWrap(state, wrap.from, wrap.to, symbol.name)
          : null;
      if (change) {
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
      const subclass = context.kind === 'word' ? context.subclass : undefined;
      if (subclass?.icon && subclass.icon === symbol.name && symbol.id.startsWith('icon:')) {
        const name = subclass.canonical;
        const element = subclass.icon;
        const nameTag = { from: context.from, element, name };
        const insert = `<${element} ${name} />`;
        const tagged = checkedNameTag(state, context.from, context.to, element, name, globals);
        push({
          id: symbol.id,
          category: 'Symbols',
          label: insert,
          about: `Tags “${name}” as ${elementLabel(element)}.`,
          insert,
          from: tagged?.from,
          nameTag,
          ...(tagged ? {} : { unavailable: unavailableReasons.context }),
          usage: symbol.usage,
          keys: `${query} ${symbol.keywords}`,
        });
        continue;
      }
      const tag = `<${symbol.name}/>`;
      const keepWord = subclass?.icon === null && symbol.id.startsWith('icon:');
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
    if (offeredHere(enhancedArrowSnippet.id, globals)) addSnippet(enhancedArrowSnippet, 'Symbols');
    if (
      context.kind === 'selection' &&
      context.selection.trim() &&
      canSaveSnippets() &&
      !skip?.has('save-snippet')
    )
      push({
        id: 'save-snippet',
        category: 'Snippets',
        label: 'Save as snippet',
        about: 'Saves the selected text as one of your snippets.',
        insert: '',
        preview: null,
        reference: true,
        saveSnippet: true,
        ...(snippetTemplateIssue(context.selection)
          ? { unavailable: 'Fix the markup in the editor before saving it as a snippet.' }
          : {}),
        keys: 'save snippet new mine',
      });
    addCustom();
    for (const snippet of markupSnippets) {
      // The pair and everything that writes the enhanced arrow share one category gate.
      if (!offeredHere(snippet.id, globals)) continue;
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

/**
 * "Group with icon" for the pair at the caret (its icon, or in its words) or selected: the icon and
 * its words become one tagged span. None when the selection is exactly the words of a joined pair:
 * the element wraps there do the same.
 */
export function groupItem(state: EditorState, globals: MarkupGlobals): SuggestItem | null {
  const pair = pairAt(state);
  if (!pair) return null;
  const { from, to } = state.selection.main;
  if (!pair.spaced && from === pair.from && to === pair.to) return null;
  const change = groupChange(state, pair, globals);
  if (!change) return null;
  const element = elementLabel(pair.element);
  const line = state.doc.lineAt(change.from);
  return {
    id: 'transform:group-with-icon',
    category: 'Transforms',
    label: 'Group with icon',
    hint: change.dropsSpace ? 'drops the space' : element,
    about: change.dropsSpace
      ? `Tags “${pair.text}” as ${element} with its icon. The space after the icon goes, which changes the text; you are asked first.`
      : `Tags “${pair.text}” as ${element}: the icon and its words become one tagged span. What readers see stays the same.`,
    from: change.from,
    to: change.to,
    insert: change.insert,
    stops: [],
    preview:
      line.text.slice(0, change.from - line.from) +
      change.insert +
      line.text.slice(change.to - line.from),
    group: change.dropsSpace ? 'spaced' : 'joined',
    pinned: true,
    keys: `group icon tag ${pair.element} ${pair.text}`,
  };
}

/** The fixed order of everything below the pinned options: the same every time, so it can be learned. */
const everyOrder: readonly SuggestCategory[] = [
  'Numbers',
  'Transforms',
  'Snippets',
  'Tags',
  'Symbols',
  'Variables',
  'Globals',
];
const rowIds = new Set(suggestionRowOrder);

function catalogueOrder(items: SuggestItem[]): SuggestItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const row = suggestionRowOrder.flatMap((id) => {
    const item = byId.get(id);
    return item ? [{ ...item, category: 'Markup tools' as const }] : [];
  });
  return [
    ...row,
    ...everyOrder.flatMap((category) =>
      items.filter((item) => item.category === category && !rowIds.has(item.id)),
    ),
  ];
}

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
  const group = groupItem(state, globals);
  // With no query or selection, put the whole set of row tools in their shared catalogue order.
  const bare = context.kind === 'word' && !context.query;
  const pinned = [
    ...(group ? [group] : []),
    ...suggestItems(context, state, globals, recent, true).filter(
      (item) => !bare || !rowIds.has(item.id),
    ),
  ];
  const taken = new Set(pinned.map((item) => item.id));
  const others = build(context, state, globals, true, taken).filter(
    (item) => !context.query || matchScore(item, context.query) > 0,
  );
  for (const item of pinned) item.pinned = true;
  return [...pinned, ...catalogueOrder(others)];
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
    if (item.unavailable || item.reference || item.wrap || item.nameTag || item.group) return item;
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
  const ordered = catalogueOrder(build(context, state, globals, true));
  const place = new Map(
    ordered.map((item, index) => [item.id, { index, category: item.category }]),
  );
  return items
    .map((item) =>
      item.pinned
        ? { ...item, pinned: false, category: place.get(item.id)?.category ?? item.category }
        : item,
    )
    .sort((a, b) => (place.get(a.id)?.index ?? Infinity) - (place.get(b.id)?.index ?? Infinity));
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
    subclass: undefined,
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
  selection: ['Transforms', 'Numbers', 'Snippets', 'Tags', 'Symbols'],
  tag: ['Tags', 'Symbols', 'Snippets', 'Globals'],
  variable: ['Numbers', 'Variables', 'Globals', 'Symbols', 'Snippets'],
  'title-name': ['Globals'],
  'import-source': ['Globals'],
  'import-name': ['Globals'],
  word: ['Numbers', 'Snippets', 'Tags', 'Symbols', 'Variables', 'Globals'],
};

const wrapOrder: SuggestCategory[] = ['Transforms', 'Snippets', 'Symbols', 'Tags'];

const perCategory = 24;

/** Typed score ties (owner Q4): Mine, then Team, then built-in. */
const sourceRank = (item: SuggestItem) =>
  item.source === 'mine' ? 0 : item.source === 'team' ? 1 : 2;

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
          // Over a selection, "Save as snippet" leads the Snippets: it is an action, not a snippet.
          Number(!!b.item.saveSnippet) - Number(!!a.item.saveSnippet) ||
          b.score - a.score ||
          Number(!!b.item.wrap) - Number(!!a.item.wrap) ||
          (context.query ? 0 : a.recency - b.recency) ||
          (context.query
            ? sourceRank(a.item) - sourceRank(b.item)
            : Number(!!a.item.source) - Number(!!b.item.source)) ||
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
