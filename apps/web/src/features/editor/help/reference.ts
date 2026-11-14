import type { EditorState } from '@codemirror/state';
import {
  findRetiredMarkup,
  baseEnhancedPairs,
  markupCommentContext,
  markupIcons,
  type MarkupGlobals,
} from '@clarity/core';
import { markupEntries, type MarkupEntry } from '../markupRow/entries';
import { previousCategoryLabel } from '../../../services/categoryLabels';

/**
 * The markup help's reference: where each registry entry sits on the sheet, the rows that are not
 * options (math, the empty variable, comments, blank lines), the two worked examples, and the
 * editor's keys. Names, explanations, and examples come from the registry (`markupEntries()` and
 * core `markupSnippets`, their `help` field); nothing here repeats them.
 */

export interface HelpRow {
  id: string;
  group: string;
  label: string;
  about: string;
  /** What you write, drawn live beside it. */
  example?: string;
  /** Said where nothing is drawn, or after the render. */
  note?: string;
  /** The worked example this row's lines belong to (see helpBlocks). */
  block?: string;
  /** The example is a description ("an empty line"), not markup. */
  plain?: boolean;
  /** A keys row: the keys, alternatives split by ` / `. */
  keys?: string;
  /** Lower-case text the filter searches. */
  words: string;
  /** What Insert runs: the same entry the markup row, "All", and Ctrl+Space use. */
  entry?: MarkupEntry;
}

/** A worked example: several rows share one piece of text, drawn once (or as Base and Enhanced). */
export interface HelpBlock {
  lines: readonly { text: string; row: string }[];
  enhanced?: boolean;
  note?: string;
}

export const helpBlocks: Readonly<Record<string, HelpBlock>> = {
  'base-enhanced-pair': {
    enhanced: true,
    lines: [{ text: '{{10%}{15%}}', row: 'base-enhanced-pair' }],
  },
  enhanced: {
    enhanced: true,
    lines: [
      { text: 'for <enhanced/>${7+#{d}} seconds', row: 'enhanced-formula' },
      { text: 'enhanced (', row: 'enhanced-block' },
      { text: 'var d = 1', row: 'enhanced-formula' },
      { text: '<enhanced/> Lasts longer.', row: 'enhanced-arrow' },
      { text: ')', row: 'enhanced-block' },
    ],
  },
  title: {
    note: 'Shown on hover.',
    lines: [
      { text: '<title jolted [Jolt] />', row: 'title' },
      { text: 'title Jolt (', row: 'decl-title' },
      { text: 'Chains lightning.', row: 'decl-title' },
      { text: ')', row: 'decl-title' },
    ],
  },
};

/**
 * Examples never depend on the app's data: the sheet works before the data has loaded, and a
 * global named like an example's variable cannot change a row. The arrow `<enhanced/>` is read
 * as the legacy `#e`, the global variable e.
 */
export const helpGlobals: MarkupGlobals = {
  variables: 'var e = 🡅',
  titles: '',
  // The import row's example names a real tooltip; its text stands in, so the row checks clean.
  imports: { '554409585': 'Its main text.' },
};
export const helpEnhancedGlobals: MarkupGlobals = {
  ...helpGlobals,
  // The parser still takes the generator's legacy type, rather than the presented UI label.
  type: previousCategoryLabel('weapon-trait-enhanced'),
};

/** The rows that are not markup options. */
const extraRows: readonly Omit<HelpRow, 'words'>[] = [
  {
    id: 'list-dot',
    group: 'Lists',
    label: 'List dot',
    about: 'Start a list by typing a hyphen, then Space.',
    example: '• text',
    note: 'Type - then Space.',
  },
  {
    id: 'comment',
    group: 'Comments and spacing',
    label: 'Comment',
    example: '// to the end of the line\n/* or several lines */',
    note: 'Not drawn.',
    about: 'A note for other editors, never drawn or exported: // to the line’s end, or /* … */.',
  },
  {
    id: 'blank',
    group: 'Comments and spacing',
    label: 'Blank line',
    example: 'an empty line',
    plain: true,
    note: 'Draws one gap.',
    about: 'One empty line draws a gap. Several in a row draw the same single gap.',
  },
  {
    id: 'var-empty',
    group: 'Variables and math',
    label: 'Empty variable',
    example: 'var x = empty',
    note: '#x writes nothing.',
    about: 'The value empty makes #name write nothing, which hides an optional sentence.',
  },
  {
    id: 'var-braces',
    group: 'Variables and math',
    label: 'Variable before letters',
    example: 'var w = 10\n#{w}px wide',
    note: 'Braces end the name.',
    about: 'Write #{name} when letters or digits follow, so they are not read as part of the name.',
  },
  {
    id: 'math',
    group: 'Variables and math',
    label: 'Math',
    example: '${10 * 2}% energy',
    about: 'Works out + - * / inside ${ … }, to at most two decimals. Variables work inside it.',
  },
];

const extraWords: Record<string, string> = {
  comment: 'comment note slash hidden',
  blank: 'blank empty line gap spacer space',
  'var-empty': 'variable empty nothing blank',
  'var-braces': 'variable braces curly delimit merge letters after name',
  math: 'math formula calculate dollar plus minus times',
};

export interface EditorKey {
  id: string;
  group: string;
  label: string;
  /** At most 19 characters, so three key columns fit 768px. */
  keys: string;
  about: string;
  words: string;
}

/** The editor's keys: the help's key rows and the status bar's hints read this one list. */
export const editorKeys: readonly EditorKey[] = [
  {
    id: 'key-suggest',
    group: 'Keys: write',
    label: 'Suggest markup',
    keys: 'Ctrl+Space',
    about: 'Every option, the fitting ones first. Press again for the next category.',
    words: 'suggest complete autocomplete menu all',
  },
  {
    id: 'key-stops',
    group: 'Keys: write',
    label: 'Next, previous blank',
    keys: 'Tab / Shift+Tab',
    about: 'After inserting a snippet, Tab moves through its blanks. Esc drops them.',
    words: 'tab stop placeholder snippet blank',
  },
  {
    id: 'key-row',
    group: 'Keys: write',
    label: 'Markup row button',
    keys: '1 – 9',
    about:
      'Presses the nth button, with focus in the markup row. Arrows move along it; Esc leaves.',
    words: 'markup row toolbar number',
  },
  {
    id: 'key-tag',
    group: 'Keys: write',
    label: 'Open the caret’s tag',
    keys: 'Alt+Enter',
    about: 'On tagged text (also Alt+click). Backspace then removes the tag and keeps the text.',
    words: 'tag colour color remove unwrap',
  },
  {
    id: 'key-comment',
    group: 'Keys: write',
    label: 'Comment the line',
    keys: 'Ctrl+/',
    about: 'Puts // before the selected lines, or takes it away again.',
    words: 'comment slash toggle',
  },
  {
    id: 'key-help',
    group: 'Keys: write',
    label: 'This help',
    keys: 'F1',
    about: 'Opens this sheet on the markup the caret is in. F1 or Esc closes it.',
    words: 'help f1',
  },
  {
    id: 'key-find',
    group: 'Keys: find and go',
    label: 'Find, replace',
    keys: 'Ctrl+F / Ctrl+H',
    about: 'Enter and Shift+Enter step through the matches.',
    words: 'find search replace',
  },
  {
    id: 'key-definition',
    group: 'Keys: find and go',
    label: 'Go to definition',
    keys: 'F12 / Ctrl+Click',
    about: 'Of a #variable, title, or import. The browser Back button returns.',
    words: 'definition go to jump variable title import',
  },
  {
    id: 'key-peek',
    group: 'Keys: find and go',
    label: 'Peek at contents',
    keys: 'Ctrl+K Ctrl+I',
    about: 'Shows what a #variable, title, or import contains, as hovering it does.',
    words: 'peek hover contains',
  },
  {
    id: 'key-conflict',
    group: 'Keys: find and go',
    label: 'Next, prior conflict',
    keys: 'F8 / Shift+F8',
    about: 'Jumps between unresolved conflicts, while the text has any.',
    words: 'conflict next previous',
  },
  {
    id: 'key-leave',
    group: 'Keys: find and go',
    label: 'Leave the editor',
    keys: 'Esc, then Tab',
    about: 'Tab alone does nothing in the text. Esc first hands it back to the page.',
    words: 'leave focus tab escape',
  },
  {
    id: 'key-raw',
    group: 'Keys: view',
    label: 'Raw markup on, off',
    keys: 'Ctrl+Shift+.',
    about: 'Shows the markup as stored, or as symbols and colours. The same as the Raw button.',
    words: 'raw symbols stored',
  },
  {
    id: 'key-markup-row',
    group: 'Keys: view',
    label: 'Markup row on, off',
    keys: 'Ctrl+.',
    about: 'Shows or hides the markup row. Remembered on this device.',
    words: 'markup row toolbar toggle',
  },
  {
    id: 'key-preview',
    group: 'Keys: view',
    label: 'Show the preview',
    keys: 'Alt+P',
    about: 'Shows the preview column while it is hidden, or has changes it has not shown.',
    words: 'preview show',
  },
  {
    id: 'key-changes',
    group: 'Keys: view',
    label: 'Changes since save',
    keys: 'Ctrl+K D',
    about: 'Shows or hides what changed since the last save.',
    words: 'changes diff saved compare',
  },
];

/** A key's label as the status bar hints write it. */
export function keyOf(id: string): string {
  const found = editorKeys.find((key) => key.id === id);
  if (!found) throw new Error(`Missing key ${id}`);
  return found.keys.split(' / ')[0]!.replace(', then ', ' then ');
}

const icons = markupIcons.map((name) => `icon:${name}`);

/** Where each row sits, group by group, in reading order. */
export const helpLayout: Readonly<Record<string, readonly string[]>> = {
  Values: ['pair', 'pve', 'pvp', 'pvp-override'],
  Lists: ['list-dot'],
  Text: ['inline:bold', 'inline:yellow', 'line:bold'],
  Icons: ['icon-word', ...icons],
  'Comments and spacing': ['comment', 'blank'],
  Enhanced: ['base-enhanced-pair', 'enhanced-formula', 'enhanced-block', 'enhanced-arrow'],
  'Variables and math': ['decl-var', 'var-braces', 'var-empty', 'math'],
  References: ['link', 'title', 'decl-title'],
  Sharing: ['decl-import', 'decl-export', 'decl-export-hidden'],
  ...Object.fromEntries(
    [...new Set(editorKeys.map((key) => key.group))].map((group) => [
      group,
      editorKeys.filter((key) => key.group === group).map((key) => key.id),
    ]),
  ),
};

/** The sheet's columns: what goes in a line, what is declared around it, and the keys. */
export const helpColumns: readonly (readonly string[])[] = [
  ['Values', 'Lists', 'Text', 'Icons', 'Comments and spacing'],
  ['Enhanced', 'Variables and math', 'References', 'Sharing'],
  ['Keys: write', 'Keys: find and go', 'Keys: view'],
];

/** One column (a phone): markup only, by how often each group is written. */
export const phoneGroups: readonly string[] = [
  'Values',
  'Lists',
  'Text',
  'Icons',
  'Enhanced',
  'Variables and math',
  'References',
  'Sharing',
  'Comments and spacing',
];

/** Shown at the right of a group's heading. */
export const groupHints: Readonly<Record<string, string>> = { Icons: '<name/>' };

let built: HelpRow[] | null = null;

/** Every row, in layout order. Built once, on the first open. */
export function helpRows(): readonly HelpRow[] {
  if (built) return built;
  const entries = new Map(
    markupEntries({ ...helpGlobals, allowBaseEnhanced: true })
      .filter((entry) => entry.help)
      .map((entry) => [entry.id, entry]),
  );
  const rows: HelpRow[] = [];
  for (const [group, ids] of Object.entries(helpLayout)) {
    for (const id of ids) {
      const entry = entries.get(id);
      const extra = extraRows.find((row) => row.id === id);
      const key = editorKeys.find((row) => row.id === id);
      if (entry) {
        const help = entry.help!;
        const lines = help.block
          ? helpBlocks[help.block]!.lines.filter((line) => line.row === id).map((line) => line.text)
          : [];
        rows.push({
          id,
          group,
          label: entry.label,
          about: entry.about,
          example: help.example,
          note: help.note,
          block: help.block,
          entry,
          words:
            `${entry.label} ${entry.markup} ${entry.keys} ${help.example ?? ''} ${lines.join(' ')} ${group}`.toLowerCase(),
        });
      } else if (extra) {
        rows.push({
          ...extra,
          group,
          words:
            `${extra.label} ${extra.example ?? ''} ${extraWords[id] ?? ''} ${group}`.toLowerCase(),
        });
      } else if (key) {
        rows.push({
          ...key,
          group,
          words: `${key.label} ${key.keys} ${key.words} ${group}`.toLowerCase(),
        });
      } else throw new Error(`Markup help: no entry for ${id}`);
    }
  }
  built = rows;
  return rows;
}

/** Retired markup a search can name: a sample of each, so the answer is retired.ts's own words. */
const retiredSamples: readonly { name: string; sample: string; instead?: string }[] = [
  { name: 'blue', sample: '<blue x />', instead: 'inline:yellow' },
  { name: 'green', sample: '<green x />', instead: 'inline:yellow' },
  { name: 'purple', sample: '<purple x />', instead: 'inline:yellow' },
  { name: 'center', sample: '<center/>' },
  { name: 'centre', sample: '<center/>' },
  { name: 'background', sample: '<background/>' },
  { name: 'breakspaces', sample: '<breakSpaces/>' },
  { name: 'catalyst', sample: 'catalyst (\nx\n)' },
  { name: 'exotic perk', sample: 'exotic perk (\nx\n)' },
  { name: 'table', sample: '< table x >\n| a |\n<$>' },
];

export interface RetiredAnswer {
  message: string;
  /** The row to make active: what replaces it, if anything does. */
  instead?: string;
}

/** A query of three or more letters that names retired markup answers with what to do instead. */
export function retiredAnswer(query: string): RetiredAnswer | null {
  const asked = query.trim().toLowerCase();
  if (asked.length < 3) return null;
  const found = retiredSamples.find(
    ({ name }) => name.startsWith(asked) || asked.split(/\s+/).includes(name) || asked === name,
  );
  if (!found) return null;
  const occurrence = findRetiredMarkup(found.sample)[0];
  if (!occurrence) return null;
  // retired.ts's own advice, after the form's name: "<blue … /> is retired. Remove the tag …".
  const advice = occurrence.message.split('no longer supported. ')[1] ?? occurrence.message;
  return { message: `${occurrence.token} is retired. ${advice}`, instead: found.instead };
}

/** The help row for an option in the Ctrl+Space menu (F1 there), if one teaches it. */
export function helpIdForSuggestion(id: string): string | null {
  const bare = id.replace(/^snippet:/, '');
  const mapped: Record<string, string> = {
    'tag:pve': 'pve',
    'tag:pvp': 'pvp',
    'tag:bold': 'inline:bold',
    'tag:yellow': 'inline:yellow',
    'wrap:bold': 'inline:bold',
    'wrap:yellow': 'inline:yellow',
    'tag:title': 'title',
    'title-ref': 'title',
    'tag:link': 'link',
    'link-ref': 'link',
  };
  if (mapped[bare]) return mapped[bare];
  if (bare.startsWith('style:')) return `line:${bare.slice(6)}`;
  if (bare.startsWith('var:')) return 'decl-var';
  if (bare.startsWith('ref:')) return 'title';
  if (bare.startsWith('title:')) return 'decl-title';
  if (bare.startsWith('import-')) return 'decl-import';
  return helpRows().some((row) => row.id === bare) ? bare : null;
}

const within = (column: number, match: RegExpMatchArray) =>
  column >= match.index! && column <= match.index! + match[0].length;

/** The help row for a construct on one line, with the caret at `column`. */
function rowInLine(line: string, column: number): string | null {
  if (baseEnhancedPairs(line).some((pair) => column >= pair.from && column <= pair.to))
    return 'base-enhanced-pair';
  for (const match of line.matchAll(
    /(?:#e|<enhanced\/>)\$\{(?:#\{[a-zA-Z0-9]+\}|[^}])*\}|\$\{(?:#\{[a-zA-Z0-9]+\}|[^}])*\}/g,
  ))
    if (within(column, match)) return match[0].startsWith('$') ? 'math' : 'enhanced-formula';
  for (const match of line.matchAll(/<([a-zA-Z]+)(?:\s[^<>]*?)?\/>/g)) {
    if (!within(column, match)) continue;
    const name = match[1]!;
    const before = line.slice(0, match.index);
    if (name === 'pve')
      return /^<pve [^<>]*\/>\s*<pvp /.test(line.slice(match.index)) ? 'pair' : 'pve';
    if (name === 'pvp') {
      if (/<pve [^<>]*\/>\s*$/.test(before)) return 'pair';
      return /[\w%] $/.test(before) ? 'pvp-override' : 'pvp';
    }
    if (name === 'bold') return match[0] === '<bold/>' ? 'line:bold' : 'inline:bold';
    if (name === 'yellow') return 'inline:yellow';
    if (name === 'link') return 'link';
    if (name === 'title') return 'title';
    if (name === 'enhanced' && match[0] === '<enhanced/>') return 'enhanced-arrow';
    if ((markupIcons as readonly string[]).includes(name))
      return /^[A-Za-z]/.test(line.slice(match.index! + match[0].length))
        ? 'icon-word'
        : `icon:${name}`;
  }
  for (const match of line.matchAll(/#e(?![a-zA-Z0-9])|#\{[a-zA-Z0-9]+\}|#[a-zA-Z0-9]+/g))
    if (within(column, match))
      return match[0] === '#e' ? 'enhanced-arrow' : match[0][1] === '{' ? 'var-braces' : 'decl-var';
  if (/^enhanced \(/.test(line)) return 'enhanced-block';
  if (/^title .+ \(/.test(line)) return 'decl-title';
  if (/^var /.test(line)) return /=\s*empty\s*$/.test(line) ? 'var-empty' : 'decl-var';
  if (/^import /.test(line)) return 'decl-import';
  if (/^export hidden /.test(line)) return 'decl-export-hidden';
  if (/^export /.test(line)) return 'decl-export';
  if (line.startsWith('• ')) return 'list-dot';
  return null;
}

/**
 * The help row for the markup under the caret (F1): the construct on the caret's line, else the
 * block the line sits in (an enhanced section, a title body, an export), else none.
 */
export function helpIdAt(state: EditorState, pos: number): string | null {
  // Comments as production reads them (`//` at a line start or after a space, `/* */` across
  // lines), so `https://` in a link is not one.
  const doc = state.doc.toString();
  for (const { from, to } of markupCommentContext(doc).comments) {
    const end = doc[to - 1] === '\n' ? to - 1 : to;
    if (pos >= from && pos <= end) return 'comment';
  }
  const line = state.doc.lineAt(pos);
  const here = rowInLine(line.text, pos - line.from);
  if (here) return here;
  if (line.text.trim() === '') return 'blank';
  // Up to the block that encloses this line, if any; a closing `)` first means none does.
  for (let number = line.number - 1, seen = 0; number >= 1 && seen < 400; number--, seen++) {
    const text = state.doc.line(number).text;
    if (/^\)\s*$/.test(text)) return null;
    if (/^enhanced \(\s*$/.test(text)) return 'enhanced-block';
    if (/^title .+ \(\s*$/.test(text)) return 'decl-title';
    if (/^export hidden .+ \(\s*$/.test(text)) return 'decl-export-hidden';
    if (/^export .+ \(\s*$/.test(text)) return 'decl-export';
  }
  return null;
}
