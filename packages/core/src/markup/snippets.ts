import { markupEmpty, markupIcons, markupRetiredLineStyles } from './syntax.js';

/**
 * The editor's snippet catalogue. A template is plain markup with tab stops written `{{1:default}}`
 * (`{{0}}` marks where the caret ends). Nothing here changes the grammar: every snippet expands to
 * text the existing parser already understands, and the catalogue is pure data so the suggestion
 * menu, the markup row and the chips can all share it.
 */

export type SnippetGroup = 'Values' | 'Enhanced' | 'Icons' | 'References' | 'Format' | 'Blocks';

export interface Snippet {
  /** Stable; used for the recently-used list and the usage-count cache. */
  id: string;
  label: string;
  group: SnippetGroup;
  /** `{{n:default}}` tab stops; a leading selection replaces the first stop's default. */
  template: string;
  /** Extra words the menu's fuzzy filter matches. */
  keywords: string;
  /** Matches one use in a tooltip's text, for the corpus usage count. */
  usage: RegExp;
  /** Starts at the beginning of a line (a multi-line declaration). */
  block?: boolean;
  /** A selection is wrapped, one tag per line. */
  wraps?: boolean;
  /** A selection becomes the first stop's value (without being wrapped per line). */
  fromSelection?: boolean;
  /** One-line description for the menu's detail pane. */
  about: string;
  /** How the markup help shows it (an entry with this field gets a row there). */
  help?: MarkupHelpExample;
}

/**
 * A markup help row's example: a real construct cut to one short line, drawn beside itself. Rows
 * taught by a shared worked example name it in `block` instead of carrying their own text.
 */
export interface MarkupHelpExample {
  /** What you write, drawn live beside it (absent for a row shown through a worked example). */
  example?: string;
  /** Said where nothing is drawn, or after the render. */
  note?: string;
  /** The worked example this row's lines belong to. */
  block?: string;
}

export interface ExpandedTemplate {
  text: string;
  /** Tab stops in order (`{{0}}` last), as offsets into `text`. */
  stops: { from: number; to: number }[];
}

const stopPattern = /\{\{(\d+)(?::((?:[^{}]|\{(?!\{))*?))?\}\}/g;

/**
 * Expands a template. `replacement` (the user's selection) takes the place of the first stop's
 * default text; further stops keep theirs. Stops sharing a number are not mirrored: each is a stop.
 */
export function expandTemplate(template: string, replacement?: string): ExpandedTemplate {
  let text = '';
  let last = 0;
  const found: { number: number; from: number; to: number }[] = [];
  let first = true;
  for (const match of template.matchAll(stopPattern)) {
    text += template.slice(last, match.index);
    last = match.index + match[0].length;
    const number = Number(match[1]);
    let value = match[2] ?? '';
    if (first && number > 0 && replacement !== undefined && replacement !== '') {
      value = replacement;
      first = false;
    } else if (number > 0) first = false;
    found.push({ number, from: text.length, to: text.length + value.length });
    text += value;
  }
  text += template.slice(last);
  found.sort((a, b) => (a.number || 1e9) - (b.number || 1e9));
  return { text, stops: found.map(({ from, to }) => ({ from, to })) };
}

/** A snippet expanded for a selection: wrapping snippets repeat per line. */
export function expandSnippet(snippet: Snippet, selection = ''): ExpandedTemplate {
  if (!snippet.wraps || !selection.includes('\n'))
    return expandTemplate(snippet.template, selection);
  const lines = selection.split('\n');
  const expanded = lines.map((line) => expandTemplate(snippet.template, line));
  let text = '';
  const stops: ExpandedTemplate['stops'] = [];
  for (const [index, line] of expanded.entries()) {
    if (index) text += '\n';
    for (const stop of line.stops)
      stops.push({ from: text.length + stop.from, to: text.length + stop.to });
    text += line.text;
  }
  return { text, stops: stops.length ? [stops[0]!] : [] };
}

const wrap = (tag: string, about: string): Snippet => ({
  id: `wrap:${tag}`,
  label: `<${tag} text />`,
  group: 'Format',
  template: `<${tag} {{1:text}} />`,
  keywords: `${tag} wrap colour color format`,
  usage: new RegExp(`<${tag} `),
  wraps: true,
  about,
});

export const markupSnippets: readonly Snippet[] = [
  {
    id: 'pair',
    label: 'PvE and PvP values',
    group: 'Values',
    template: '<pve {{1:value}} /> <pvp [{{2:value}}] />',
    keywords: 'pve pvp pair both numbers values',
    usage: /<pve [^<>]*\/>\s*<pvp /,
    fromSelection: true,
    about: 'A value for PvE and the bracketed PvP value beside it.',
    help: { example: '<pve 1 /> <pvp [2] />' },
  },
  {
    id: 'pve',
    label: '<pve value />',
    group: 'Values',
    template: '<pve {{1:value}} />',
    keywords: 'pve value number',
    usage: /<pve /,
    wraps: true,
    about: 'A PvE-only value.',
    help: { example: '<pve PvE: 10%|20% />' },
  },
  {
    id: 'pvp',
    label: '<pvp [value] />',
    group: 'Values',
    template: '<pvp [{{1:value}}] />',
    keywords: 'pvp value number',
    usage: /<pvp /,
    wraps: true,
    about: 'A PvP-only value, shown in brackets.',
    help: { example: '<pvp PvP: 2%|4% />' },
  },
  {
    id: 'pvp-override',
    label: 'Value with PvP override',
    group: 'Values',
    template: '{{1:value}} <pvp [{{2:value}}] />',
    keywords: 'pvp override after value unit seconds',
    usage: /[\w%] <pvp \[/,
    fromSelection: true,
    about: 'A plain value followed by the PvP number; the unit stays outside the tag.',
    help: { example: '1 <pvp [2] /> stacks' },
  },
  {
    id: 'enhanced-block',
    label: 'Enhanced section',
    group: 'Enhanced',
    template: 'enhanced (\nvar d = {{1:amount}}\n#e {{2:What the enhanced version changes.}}\n)',
    keywords: 'enhanced block arrow section var',
    usage: /^enhanced \(/m,
    block: true,
    about: 'The enhanced-only section. The #e line already carries the enhanced arrow.',
    help: { block: 'enhanced' },
  },
  {
    id: 'enhanced-formula',
    label: '#e${base+#d}',
    group: 'Enhanced',
    template: '#e${{{1:base}}+#d}',
    keywords: 'enhanced formula e d base add bonus',
    usage: /#e\$\{/,
    about: 'The base value with the enhanced bonus #d added in the enhanced version.',
    help: { block: 'enhanced' },
  },
  {
    id: 'icon-word',
    label: 'Element icon and word',
    group: 'Icons',
    template: '<{{1:solar}}/>{{2:Solar}}',
    keywords: 'element icon word arc solar void stasis strand kinetic',
    usage: /<(?:kinetic|arc|solar|void|stasis|strand)\/>[A-Za-z]/,
    about: 'An element icon followed by its name.',
    help: { example: 'Applies <arc/>Jolt.' },
  },
  {
    id: 'title-ref',
    label: 'Title reference',
    group: 'References',
    template: '<title {{1:Text}} [{{2:Name}}] />',
    keywords: 'title reference global tooltip hover definition',
    usage: /<title /,
    wraps: true,
    about: 'Text that shows a title definition when hovered.',
  },
  {
    id: 'link-ref',
    label: 'Link',
    group: 'References',
    template: '<link {{1:Text}} [{{2:https://example.com}}] />',
    keywords: 'link url web reference',
    usage: /<link /,
    wraps: true,
    about: 'Text that links to a web address.',
  },
  wrap('yellow', 'Yellow text.'),
  wrap('bold', 'Bold text.'),
  {
    id: 'decl-var',
    label: 'var name = value',
    group: 'Blocks',
    template: 'var {{1:name}} = {{2:value}}',
    keywords: 'var variable declare define',
    usage: /^var /m,
    block: true,
    about: 'A variable, used elsewhere as #name.',
    help: { example: 'var Zoom = 1\nZoom +#Zoom' },
  },
  {
    id: 'decl-title',
    label: 'title Name ( … )',
    group: 'Blocks',
    template: 'title {{1:Name}} (\n{{2:text}}\n)',
    keywords: 'title block definition global',
    usage: /^title [A-Za-z0-9 ]+ \(/m,
    block: true,
    about: 'A title definition other text can point at.',
    help: { block: 'title' },
  },
  {
    id: 'decl-export',
    label: 'export Name ( … )',
    group: 'Blocks',
    template: 'export {{1:Name}} (\n{{2:text}}\n)',
    keywords: 'export share',
    usage: /^export /m,
    block: true,
    about: 'A named text other tooltips can import.',
    help: { example: 'export name ( … )', note: 'Drawn here too.' },
  },
  {
    id: 'decl-export-hidden',
    label: 'export hidden Name ( … )',
    group: 'Blocks',
    template: 'export hidden {{1:Name}} (\n{{2:text}}\n)',
    keywords: 'export hidden share',
    usage: /^export hidden /m,
    block: true,
    about: 'An export that does not show in this tooltip.',
    help: { example: 'export hidden name ( … )', note: 'Not drawn here.' },
  },
  {
    id: 'decl-import',
    label: 'import name from …',
    group: 'Blocks',
    template: 'import {{1:name}} from {{2:global}}',
    keywords: 'import use',
    usage: /^import /m,
    block: true,
    about: 'Brings in text another tooltip or the globals export.',
    help: { example: 'import main from 554409585', note: 'Draws its text.' },
  },
];

/** The tags that wrap text, as the menu's Tags category lists them. */
export interface TagEntry {
  id: string;
  label: string;
  template: string;
  keywords: string;
  usage: RegExp;
  about: string;
}

export const markupTags: readonly TagEntry[] = [
  {
    id: 'tag:pve',
    label: '<pve />',
    template: '<pve {{1:value}} />',
    keywords: 'pve',
    usage: /<pve /,
    about: 'A PvE-only value.',
  },
  {
    id: 'tag:pvp',
    label: '<pvp />',
    template: '<pvp [{{1:value}}] />',
    keywords: 'pvp',
    usage: /<pvp /,
    about: 'A PvP-only value, shown in brackets.',
  },
  ...['yellow'].map((name) => ({
    id: `tag:${name}`,
    label: `<${name} />`,
    template: `<${name} {{1:text}} />`,
    keywords: name,
    usage: new RegExp(`<${name} `),
    about: `${name[0]!.toUpperCase()}${name.slice(1)} text.`,
  })),
  {
    id: 'tag:bold',
    label: '<bold />',
    template: '<bold {{1:text}} />',
    keywords: 'bold strong',
    usage: /<bold /,
    about: 'Bold text.',
  },
  {
    id: 'tag:title',
    label: '<title />',
    template: '<title {{1:Text}} [{{2:Name}}] />',
    keywords: 'title reference',
    usage: /<title /,
    about: 'Text that shows a title definition when hovered.',
  },
  {
    id: 'tag:link',
    label: '<link />',
    template: '<link {{1:Text}} [{{2:https://example.com}}] />',
    keywords: 'link url',
    usage: /<link /,
    about: 'Text that links to a web address.',
  },
];

/** Icon and line-style tags that are written as a bare `<name/>` (no text inside). */
export interface SymbolEntry {
  id: string;
  name: string;
  keywords: string;
  usage: RegExp;
  about: string;
}

const iconAbout: Record<string, string> = {
  kinetic: 'Kinetic damage icon.',
  arc: 'Arc damage icon.',
  solar: 'Solar damage icon.',
  stasis: 'Stasis damage icon.',
  void: 'Void damage icon.',
  strand: 'Strand damage icon.',
  heavy: 'Heavy ammo icon.',
  primary: 'Primary ammo icon.',
  special: 'Special ammo icon.',
  barrier: 'Barrier champion icon.',
  overload: 'Overload champion icon.',
  unstoppable: 'Unstoppable champion icon.',
  hunter: 'Hunter class icon.',
  titan: 'Titan class icon.',
  warlock: 'Warlock class icon.',
};

const styleAbout: Record<string, string> = {
  center: 'Centres the whole line.',
  background: 'Gives the line a highlighted background.',
  breakSpaces: 'Keeps the spaces at the end of the line.',
  bold: 'Makes the whole line bold.',
};

/**
 * Line styles the parser and renderer still read (so existing tooltips keep working) but the
 * editor no longer offers: nobody reaches for them.
 */
const retiredLineStyles = markupRetiredLineStyles;

export const markupSymbols: readonly SymbolEntry[] = [
  ...markupIcons.map((name) => ({
    id: `icon:${name}`,
    name,
    keywords: `${name} icon`,
    usage: new RegExp(`<${name}/>`),
    about: iconAbout[name] ?? 'Icon.',
  })),
  ...markupEmpty
    .filter((name) => !retiredLineStyles.includes(name))
    .map((name) => ({
      id: `style:${name}`,
      name,
      keywords: `${name} line style`,
      usage: new RegExp(`<${name}/>`),
      about: styleAbout[name] ?? 'Line style.',
    })),
];
