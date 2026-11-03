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
  type ExpandedTemplate,
  type MarkupGlobals,
  type Snippet,
} from '@clarity/core';
import { locateBlocks, locateVariables } from '../references';

export type SuggestCategory = 'Transforms' | 'Snippets' | 'Tags' | 'Symbols' | 'Globals';

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
  /** Link-like text must not land in a legacy table cell. */
  link?: boolean;
  /** Fuzzy haystack beyond the label. */
  keys: string;
}

const triggers = {
  variable: /#[a-zA-Z0-9]*$/,
  title: /(?<=<title .*\[)[A-Za-z0-9_ ]*$/,
  importSource: /(?<=^import .+ from )[a-zA-Z0-9]*$/,
  importName: /(?<=^import )[A-Za-z0-9 ]*$/,
  tag: /<[a-zA-Z]*$/,
  word: /\w*$/,
};

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
    definitions: documentDefinitions(doc.toString()),
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
  const text = state.doc.toString();
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

  const variables = { ...extractVariables(text), ...extractVariables(globals.variables) };
  const titles = { ...extractBlocks(text, 'title'), ...extractBlocks(globals.titles, 'title') };
  const titleNames = Object.keys(titles);

  const addSnippet = (snippet: Snippet, category: SuggestCategory) => {
    if (snippet.block && (!context.lineIsFree || context.kind === 'selection')) return;
    const expanded = expandSnippet(snippet, context.selection);
    if (context.kind === 'selection' && !snippet.wraps && !snippet.fromSelection) return;
    push({
      id: `${category === 'Tags' ? '' : 'snippet:'}${snippet.id}`,
      category,
      label: snippet.label,
      about: snippet.about,
      insert: expanded.text,
      stops: expanded.stops,
      preview: snippet.group === 'Blocks' ? null : undefined,
      usage: snippet.usage,
      link: snippet.id === 'link-ref' || snippet.id === 'tag:link',
      keys: snippet.keywords,
    });
  };

  if (context.kind === 'selection') {
    for (const { transform, output } of applicableTransforms(context.selection, {
      titles: titleNames,
    })) {
      push({
        id: `transform:${transform.id}`,
        category: 'Transforms',
        label: transform.label,
        about: transform.about,
        insert: output,
        usage: transform.usage,
        keys: transform.label,
      });
    }
  }

  if (context.kind === 'variable') {
    for (const [name, value] of Object.entries(variables)) {
      push({
        id: `var:${name}`,
        category: 'Globals',
        label: `#${name}`,
        hint: shorten(value || 'empty'),
        about: 'A variable defined in this tooltip or the globals.',
        insert: `#${name}`,
        usage: new RegExp(`#${name}(?![a-zA-Z0-9])`),
        reference: true,
        keys: value,
      });
    }
    addSnippet(
      markupSnippets.find((snippet) => snippet.id === 'enhanced-formula')!,
      'Snippets',
    );
  }

  if (context.kind === 'title-name') {
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

  if (context.kind === 'import-source') {
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

  if (context.kind === 'import-name') {
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

  if (context.kind === 'selection' || context.kind === 'tag' || context.kind === 'word') {
    const insertAtStart = context.kind === 'selection';
    for (const symbol of markupSymbols) {
      const tag = `<${symbol.name}/>`;
      push({
        id: symbol.id,
        category: 'Symbols',
        label: tag,
        about: symbol.about,
        insert: tag,
        // With a selection the symbol goes in front of it and the selection stays.
        ...(insertAtStart ? { from: context.from, to: context.from } : {}),
        usage: symbol.usage,
        keys: symbol.keywords,
      });
    }
    for (const tag of markupTags) addSnippet(snippetOf(tag), 'Tags');
    for (const snippet of markupSnippets) {
      if (snippet.id === 'enhanced-formula') continue;
      // The Tags category carries the single tags (colours, PvE, PvP).
      if (snippet.group === 'Format' || snippet.id === 'pve' || snippet.id === 'pvp') continue;
      addSnippet(snippet, 'Snippets');
    }
    if (context.kind !== 'selection') {
      // A title reference for each known title whose name matches what was typed.
      if (query) {
        for (const name of titleNames) {
          const expanded = expandTemplate(`<title {{1:Text}} [${name}] />`);
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
        if (!query) break;
        push({
          id: `var:${name}`,
          category: 'Globals',
          label: `#${name}`,
          hint: shorten(value || 'empty'),
          about: 'A variable defined in this tooltip or the globals.',
          insert: `#${name}`,
          usage: new RegExp(`#${name}(?![a-zA-Z0-9])`),
          reference: true,
          keys: value,
        });
      }
    }
  }

  return rank(items, context, recent);
}

const defaultOrder: Record<ContextKind, SuggestCategory[]> = {
  selection: ['Transforms', 'Snippets', 'Tags', 'Symbols'],
  tag: ['Tags', 'Symbols', 'Snippets', 'Globals'],
  variable: ['Globals', 'Snippets'],
  'title-name': ['Globals'],
  'import-source': ['Globals'],
  'import-name': ['Globals'],
  word: ['Snippets', 'Tags', 'Symbols', 'Globals'],
};

const perCategory = 24;

function rank(
  items: SuggestItem[],
  context: SuggestContext,
  recent: readonly string[],
): SuggestItem[] {
  const order = defaultOrder[context.kind];
  const scored = items.flatMap((item, index) => {
    const score = context.query
      ? Math.max(
          fuzzyScore(item.label.replace(/[<>/]/g, ''), context.query) ?? -1,
          (fuzzyScore(item.keys, context.query) ?? 0) - 15,
        )
      : 0;
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
          b.score - a.score || (context.query ? 0 : a.recency - b.recency) || a.index - b.index,
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

/** The index of the first option of the next category, wrapping; used by Ctrl+Space when open. */
export function nextCategoryIndex(items: readonly SuggestItem[], current: number): number {
  const category = items[current]?.category;
  const next = items.findIndex((item, index) => index > current && item.category !== category);
  return next < 0 ? 0 : next;
}
