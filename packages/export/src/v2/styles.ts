// The four styles a new file starts from (spec section 6). A style is only a starting point: the
// page copies its format into the file's config, where every row can be changed. The compiler
// reads the config alone, so a symbol added to the engine later stays out of every existing file
// until its owner chooses it ("nothing new", owner 2026-11-11).
import type { FileData, FileFormat, StyleFile, SymbolRule } from './config.js';
import {
  configurableFormatVersion,
  iconSymbols,
  symbolIds,
  type Shape,
  type Style,
  type SymbolId,
} from './vocabulary.js';

const keep: SymbolRule = { mode: 'keep' };
const drop: SymbolRule = { mode: 'drop' };
const replace = (before: string, after = ''): SymbolRule => ({ mode: 'replace', before, after });

const iconWords: Record<(typeof iconSymbols)[number], string> = {
  kinetic: '[Kinetic]',
  arc: '[Arc]',
  solar: '[Solar]',
  stasis: '[Stasis]',
  void: '[Void]',
  strand: '[Strand]',
  prismatic: '[Prismatic]',
  heavy: '[Heavy]',
  primary: '[Primary]',
  special: '[Special]',
  barrier: '[Barrier]',
  overload: '[Overload]',
  unstoppable: '[Unstoppable]',
  hunter: '[Hunter]',
  titan: '[Titan]',
  warlock: '[Warlock]',
};

const every = (rule: (symbol: SymbolId) => SymbolRule) =>
  Object.fromEntries(symbolIds.map((symbol) => [symbol, rule(symbol)])) as Record<
    SymbolId,
    SymbolRule
  >;

const markdownSymbols = (icons: 'words' | 'drop') =>
  every((symbol) => {
    if ((iconSymbols as readonly string[]).includes(symbol))
      return icons === 'words' ? replace(iconWords[symbol as keyof typeof iconWords]) : drop;
    if (symbol === 'arrow') return replace('→');
    if (symbol === 'bold') return replace('**', '**');
    if (symbol === 'enhancedArrow') return replace('[enh]');
    return drop;
  });

export const styleShapes: Record<Style, Shape> = {
  structured: 'lines',
  markdown: 'text',
  discord: 'text',
  plain: 'text',
};

export const styleFormats: Record<Style, FileFormat> = {
  structured: {
    symbols: every(() => keep),
    titles: { mode: 'keep' },
    links: { mode: 'keep' },
    elementTags: true,
    spacer: 'keep',
  },
  markdown: {
    symbols: markdownSymbols('words'),
    titles: { mode: 'drop' },
    links: { mode: 'replace', pattern: ['[', ']', '(', ')'] },
    elementTags: true,
    spacer: 'keep',
  },
  discord: {
    symbols: markdownSymbols('drop'),
    titles: { mode: 'drop' },
    links: { mode: 'replace', pattern: ['[', ']', '(', ')'] },
    elementTags: true,
    spacer: 'keep',
  },
  plain: {
    symbols: { ...every(() => drop), arrow: replace('→') },
    titles: { mode: 'drop' },
    links: { mode: 'drop' },
    elementTags: true,
    spacer: 'keep',
  },
};

/**
 * Data defaults of a new file: English in one combined file, `name` and `edited` (the last edit
 * time per language; the editor's name is opt-in), no categories until chosen.
 */
export const defaultData = (): FileData => ({
  categories: [],
  sandboxPerks: [],
  frameAliases: true,
  languages: ['en'],
  languageFiles: 'combined',
  keys: ['name', 'edited'],
  bungieIdentical: false,
});

/**
 * A new file of a style, as the page creates it. `shape` may differ from the style's own: a
 * lines-only `keep` becomes `drop` for the text shape.
 */
export function newStyleFile(
  id: string,
  style: Style,
  data: FileData = defaultData(),
  shape: Shape = styleShapes[style],
): StyleFile {
  const format = structuredClone(styleFormats[style]);
  if (shape === 'text') {
    for (const symbol of symbolIds)
      if (format.symbols[symbol]?.mode === 'keep')
        format.symbols[symbol] = symbol === 'arrow' ? replace('→') : drop;
    if (format.titles.mode === 'keep') format.titles = { mode: 'drop' };
    if (format.links.mode === 'keep') format.links = { mode: 'drop' };
  }
  return {
    id,
    formatVersion: configurableFormatVersion,
    preset: style,
    shape,
    data: structuredClone(data),
    format,
  };
}
