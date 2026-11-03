import { EditorSelection, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import {
  expandSnippet,
  extractVariables,
  markupSnippets,
  markupSymbols,
  markupTags,
  type MarkupGlobals,
  type Snippet,
} from '@clarity/core';
import {
  insertMarkup,
  insertionMessages,
  markupOptions,
  type MarkupOption,
  type Rejection,
} from '../markupInsertion';
import { insertItem } from '../suggest/state';
import type { SuggestItem } from '../suggest/source';

/**
 * How an entry looks on its button. The row and the "All" popover draw the same glyphs, so what
 * you see on the button is what lands in the preview.
 */
export type EntryGlyph =
  | { kind: 'text'; text: string }
  | { kind: 'mono'; text: string }
  | { kind: 'icon'; name: string }
  | { kind: 'pair' }
  | { kind: 'pve' }
  | { kind: 'pvp' }
  | { kind: 'arrow'; text: string }
  | { kind: 'bold' }
  | { kind: 'colour'; colour: 'yellow' | 'blue' | 'green' | 'purple' };

export type EntryResult = 'inserted' | 'read-only' | 'composing' | Rejection;

export interface MarkupEntry {
  id: string;
  /** Popover group, in display order. */
  group: string;
  /** Names the button (accessible name, tooltip title) and feeds the popover filter. */
  label: string;
  /** The markup it writes, shown on hover. */
  markup: string;
  /** Extra words the filter matches. */
  keys: string;
  glyph: EntryGlyph;
  /** Counts uses across the corpus, for the popover footer. */
  usage?: RegExp;
  about: string;
  run(view: EditorView, globals: MarkupGlobals): EntryResult;
}

/** Messages the row shows when an insertion is refused. */
export function entryMessage(result: EntryResult): string {
  switch (result) {
    case 'inserted':
      return '';
    case 'read-only':
      return 'The markup editor is read-only.';
    case 'composing':
      return 'Finish composing text before inserting markup.';
    default:
      return insertionMessages[result];
  }
}

function guard(view: EditorView): 'read-only' | 'composing' | null {
  if (view.state.readOnly) return 'read-only';
  if (view.compositionStarted || view.composing) return 'composing';
  return null;
}

const optionFor = (id: string): MarkupOption | undefined =>
  markupOptions.find((option) => option.id === id);

/** An entry the existing insertion rules already handle (icons, line styles, wraps, link, title). */
function viaOption(id: string, rest: Omit<MarkupEntry, 'id' | 'run'>): MarkupEntry {
  return {
    id,
    ...rest,
    run(view, globals) {
      const option = optionFor(id);
      return option ? insertMarkup(view, option, globals) : 'read-only';
    },
  };
}

/**
 * Builds the option a template would insert at the selection. A block (a multi-line declaration)
 * goes on a line of its own: after the current line when this one has text on it.
 */
export function templateItem(
  state: EditorState,
  entry: { id: string; label: string; about: string; snippet: Snippet; plain?: boolean },
): SuggestItem | null {
  const main = state.selection.main;
  const snippet = entry.snippet;
  const selection = main.empty ? '' : state.sliceDoc(main.from, main.to);
  const base = {
    id: entry.id,
    category: 'Snippets' as const,
    label: entry.label,
    about: entry.about,
    preview: null,
    link: snippet.id === 'link-ref' || snippet.id === 'tag:link',
    keys: '',
  };
  if (entry.plain) {
    // Plain text that never replaces the selection (a `#e`): it goes in at the caret.
    const expanded = expandSnippet(snippet, '');
    return {
      ...base,
      from: main.head,
      to: main.head,
      insert: expanded.text,
      stops: expanded.stops,
    };
  }
  if (snippet.block) {
    if (selection) return null;
    const line = state.doc.lineAt(main.head);
    const free = line.text.trim() === '';
    const expanded = expandSnippet(snippet, '');
    if (free) {
      return {
        ...base,
        from: line.from,
        to: line.to,
        insert: expanded.text,
        stops: expanded.stops,
      };
    }
    return {
      ...base,
      from: line.to,
      to: line.to,
      insert: `\n${expanded.text}`,
      stops: expanded.stops.map((stop) => ({ from: stop.from + 1, to: stop.to + 1 })),
    };
  }
  const expanded = expandSnippet(snippet, selection);
  return { ...base, from: main.from, to: main.to, insert: expanded.text, stops: expanded.stops };
}

function viaTemplate(
  snippet: Snippet,
  rest: Omit<MarkupEntry, 'run'> & { plain?: boolean },
): MarkupEntry {
  const { plain, ...entry } = rest;
  return {
    ...entry,
    run(view) {
      const blocked = guard(view);
      if (blocked) return blocked;
      const item = templateItem(view.state, {
        id: entry.id,
        label: entry.label,
        about: entry.about,
        snippet,
        plain,
      });
      if (!item) return 'context';
      const rejection = insertItem(view, item, { typed: item.from === item.to });
      return rejection ?? 'inserted';
    },
  };
}

const bullet = '• ';

/** `• ` at the start of each selected line (lines that already have one are left alone). */
function insertBullet(view: EditorView): EntryResult {
  const blocked = guard(view);
  if (blocked) return blocked;
  const { state } = view;
  const changes: { from: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number++) {
      if (seen.has(number)) continue;
      seen.add(number);
      const line = state.doc.line(number);
      // A selection that ends at the start of a line does not include that line.
      if (number > first && !range.empty && range.to === line.from) continue;
      if (line.text.startsWith(bullet)) continue;
      changes.push({ from: line.from, insert: bullet });
    }
  }
  if (!changes.length) return 'inserted';
  view.dispatch(
    state.update({
      changes,
      selection: EditorSelection.create(
        state.selection.ranges.map((range) =>
          EditorSelection.range(
            range.anchor +
              changes.filter((change) => change.from <= range.anchor).length * bullet.length,
            range.head +
              changes.filter((change) => change.from <= range.head).length * bullet.length,
          ),
        ),
        state.selection.mainIndex,
      ),
      annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
      scrollIntoView: true,
    }),
  );
  view.focus();
  return 'inserted';
}

const iconNames = markupSymbols.filter((symbol) => symbol.id.startsWith('icon:'));
const styleSymbols = markupSymbols.filter((symbol) => symbol.id.startsWith('style:'));
const snippetById = (id: string) => {
  const found = markupSnippets.find((snippet) => snippet.id === id);
  if (!found) throw new Error(`Missing snippet ${id}`);
  return found;
};
const tagById = (id: string) => {
  const found = markupTags.find((tag) => tag.id === id);
  if (!found) throw new Error(`Missing tag ${id}`);
  return found;
};
/** The bare enhanced arrow: plain text written at the caret, never over the selection. */
const arrowSnippet: Snippet = {
  id: 'enhanced-arrow',
  label: '#e',
  group: 'Enhanced',
  template: '#e',
  keywords: 'enhanced arrow e gold up',
  usage: /#e(?![a-zA-Z0-9])/,
  about: 'The enhanced arrow, written #e.',
};

const sentence = (text: string) => text[0]!.toUpperCase() + text.slice(1);
const colours = ['yellow', 'blue', 'green', 'purple'] as const;

/** Every markup option the editor offers, grouped as the "All" popover shows them. */
export function markupEntries(globals: MarkupGlobals, documentText = ''): MarkupEntry[] {
  const pair = snippetById('pair');
  const pve = snippetById('pve');
  const pvp = snippetById('pvp');
  const entries: MarkupEntry[] = [
    {
      id: 'bullet',
      group: 'Text',
      label: 'Bullet',
      markup: '• text',
      keys: 'bullet list point dot',
      glyph: { kind: 'text', text: '•' },
      about: 'A bullet at the start of the line.',
      run: insertBullet,
    },
    viaTemplate(pair, {
      id: 'pair',
      group: 'Values',
      label: 'PvE and PvP values',
      markup: pair.template.replace(/\{\{\d+:([^}]*)\}\}/g, '$1'),
      keys: pair.keywords,
      glyph: { kind: 'pair' },
      usage: pair.usage,
      about: pair.about,
    }),
    viaTemplate(pve, {
      id: 'pve',
      group: 'Values',
      label: 'PvE only',
      markup: '<pve value />',
      keys: pve.keywords,
      glyph: { kind: 'pve' },
      usage: pve.usage,
      about: pve.about,
    }),
    viaTemplate(pvp, {
      id: 'pvp',
      group: 'Values',
      label: 'PvP only',
      markup: '<pvp [value] />',
      keys: pvp.keywords,
      glyph: { kind: 'pvp' },
      usage: pvp.usage,
      about: pvp.about,
    }),
    viaTemplate(snippetById('pvp-override'), {
      id: 'pvp-override',
      group: 'Values',
      label: 'Value with PvP override',
      markup: 'value <pvp [value] />',
      keys: snippetById('pvp-override').keywords,
      glyph: { kind: 'mono', text: 'v <pvp>' },
      usage: snippetById('pvp-override').usage,
      about: snippetById('pvp-override').about,
    }),
    ...iconNames.map((symbol) =>
      viaOption(symbol.id, {
        group: 'Icons',
        label: symbol.name,
        markup: `<${symbol.name}/>`,
        keys: symbol.keywords,
        glyph: { kind: 'icon', name: symbol.name },
        usage: symbol.usage,
        about: symbol.about,
      }),
    ),
    viaTemplate(snippetById('icon-word'), {
      id: 'icon-word',
      group: 'Icons',
      label: 'Element icon and word',
      markup: '<solar/>Solar',
      keys: snippetById('icon-word').keywords,
      glyph: { kind: 'icon', name: 'solar' },
      usage: snippetById('icon-word').usage,
      about: snippetById('icon-word').about,
    }),
    viaTemplate(arrowSnippet, {
      id: 'enhanced-arrow',
      group: 'Enhanced',
      label: 'Enhanced arrow (#e)',
      markup: '#e',
      keys: 'enhanced arrow e gold up',
      glyph: { kind: 'arrow', text: '#e' },
      about: 'The enhanced arrow, written #e.',
      usage: /#e(?![a-zA-Z0-9])/,
      plain: true,
    }),
    viaTemplate(snippetById('enhanced-formula'), {
      id: 'enhanced-formula',
      group: 'Enhanced',
      label: 'Base with enhanced bonus',
      markup: '#e${base+#d}',
      keys: snippetById('enhanced-formula').keywords,
      glyph: { kind: 'arrow', text: '${X+#d}' },
      usage: snippetById('enhanced-formula').usage,
      about: snippetById('enhanced-formula').about,
    }),
    viaTemplate(snippetById('enhanced-block'), {
      id: 'enhanced-block',
      group: 'Enhanced',
      label: 'Enhanced section',
      markup: 'enhanced ( … )',
      keys: snippetById('enhanced-block').keywords,
      glyph: { kind: 'mono', text: 'enhanced ( … )' },
      usage: snippetById('enhanced-block').usage,
      about: snippetById('enhanced-block').about,
    }),
    viaTemplate(snippetById('stack-list'), {
      id: 'stack-list',
      group: 'Enhanced',
      label: 'Stack list',
      markup: 'a|b|c at 1|2|3 Stacks',
      keys: snippetById('stack-list').keywords,
      glyph: { kind: 'mono', text: 'a|b|c' },
      usage: snippetById('stack-list').usage,
      about: snippetById('stack-list').about,
    }),
    viaOption('link', {
      group: 'References',
      label: 'Link',
      markup: '<link text [https://…] />',
      keys: tagById('tag:link').keywords,
      glyph: { kind: 'mono', text: '[link]' },
      usage: tagById('tag:link').usage,
      about: tagById('tag:link').about,
    }),
    viaOption('title', {
      group: 'References',
      label: 'Title reference',
      markup: '<title text [Name] />',
      keys: tagById('tag:title').keywords,
      glyph: { kind: 'mono', text: '[title]' },
      usage: tagById('tag:title').usage,
      about: tagById('tag:title').about,
    }),
    viaOption('inline:bold', {
      group: 'Format',
      label: 'Bold',
      markup: '<bold text />',
      keys: tagById('tag:bold').keywords,
      glyph: { kind: 'bold' },
      usage: tagById('tag:bold').usage,
      about: tagById('tag:bold').about,
    }),
    ...colours.map((colour) =>
      viaOption(`inline:${colour}`, {
        group: 'Format',
        label: sentence(colour),
        markup: `<${colour} text />`,
        keys: tagById(`tag:${colour}`).keywords,
        glyph: { kind: 'colour', colour },
        usage: tagById(`tag:${colour}`).usage,
        about: tagById(`tag:${colour}`).about,
      }),
    ),
    viaOption('inline:center', {
      group: 'Format',
      label: 'Centre text',
      markup: '<center text />',
      keys: tagById('tag:center').keywords,
      glyph: { kind: 'text', text: '≡' },
      usage: tagById('tag:center').usage,
      about: tagById('tag:center').about,
    }),
    viaOption('inline:background', {
      group: 'Format',
      label: 'Background text',
      markup: '<background text />',
      keys: tagById('tag:background').keywords,
      glyph: { kind: 'text', text: 'Bg' },
      usage: tagById('tag:background').usage,
      about: tagById('tag:background').about,
    }),
    ...styleSymbols.map((symbol) =>
      viaOption(`line:${symbol.name}`, {
        group: 'Line styles',
        label: `${sentence(symbol.name.replace(/([A-Z])/g, ' $1').toLowerCase())} line`,
        markup: `<${symbol.name}/>`,
        keys: symbol.keywords,
        glyph: { kind: 'mono', text: `<${symbol.name}/>` },
        usage: symbol.usage,
        about: symbol.about,
      }),
    ),
    ...(
      [
        'decl-var',
        'decl-title',
        'decl-export',
        'decl-export-hidden',
        'decl-import',
        'decl-catalyst',
        'decl-exotic-perk',
      ] as const
    ).map((id) => {
      const snippet = snippetById(id);
      return viaTemplate(snippet, {
        id,
        group: 'Declarations',
        label: snippet.label,
        markup: snippet.template.replace(/\{\{\d+:([^}]*)\}\}/g, '$1'),
        keys: snippet.keywords,
        glyph: { kind: 'mono', text: snippet.label },
        usage: snippet.usage,
        about: snippet.about,
      });
    }),
  ];
  const variables = { ...extractVariables(documentText), ...extractVariables(globals.variables) };
  for (const [name, value] of Object.entries(variables)) {
    entries.push({
      id: `var:${name}`,
      group: 'Variables',
      label: `#${name}`,
      markup: `#${name}`,
      keys: value,
      glyph: { kind: 'mono', text: `#${name}` },
      usage: new RegExp(`#${name}(?![a-zA-Z0-9])`),
      about: value
        ? `A variable: ${value.length > 60 ? `${value.slice(0, 59)}…` : value}`
        : 'A variable.',
      run(view) {
        const blocked = guard(view);
        if (blocked) return blocked;
        const main = view.state.selection.main;
        const item: SuggestItem = {
          id: `var:${name}`,
          category: 'Globals',
          label: `#${name}`,
          about: '',
          from: main.from,
          to: main.to,
          insert: `#${name}`,
          stops: [],
          preview: null,
          reference: true,
          keys: '',
        };
        const rejection = insertItem(view, item, { typed: false });
        return rejection ?? 'inserted';
      },
    });
  }
  return entries;
}

/** The popover's group order. */
export const entryGroups = [
  'Text',
  'Values',
  'Icons',
  'Enhanced',
  'References',
  'Format',
  'Line styles',
  'Declarations',
  'Variables',
] as const;

/**
 * What sits on the row itself, in this order: the bullet, the PvE/PvP presets, the fifteen icons,
 * the enhanced arrow, link and title, bold and the four colours, then the line styles. Everything
 * else is behind "All".
 */
export const rowOrder: readonly string[] = [
  'bullet',
  '|',
  'pair',
  'pve',
  'pvp',
  '|',
  ...iconNames.map((symbol) => symbol.id),
  '|',
  'enhanced-arrow',
  'link',
  'title',
  '|',
  'inline:bold',
  'inline:yellow',
  'inline:blue',
  'inline:green',
  'inline:purple',
  '|',
  'inline:center',
  'inline:background',
];

export const rowSeparator = '|';

export function rowEntries(entries: readonly MarkupEntry[]): (MarkupEntry | typeof rowSeparator)[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const items: (MarkupEntry | typeof rowSeparator)[] = [];
  for (const id of rowOrder) {
    if (id === rowSeparator) {
      items.push(rowSeparator);
      continue;
    }
    const found = byId.get(id);
    if (found) items.push(found);
  }
  return items;
}
