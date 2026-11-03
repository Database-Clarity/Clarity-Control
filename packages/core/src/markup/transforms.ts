import { markupIcons } from './syntax.js';

/**
 * Selection transforms: turn text the author already typed into the markup the parser wants.
 * Each rule returns the new text, or null when the selection is not unambiguously what the rule
 * handles. A selection that already holds markup is never transformed (no grammar guessing), and
 * multi-line selections transform line by line, leaving lines the rule does not match untouched.
 */

export interface TransformContext {
  /** Known title names (document and global); a bare term matching exactly one becomes a reference. */
  titles?: readonly string[];
}

export interface MarkupTransform {
  id: string;
  label: string;
  about: string;
  /** Matches a result of this transform in saved text, for the corpus usage count. */
  usage: RegExp;
  apply(input: string, context: TransformContext): string | null;
}

export interface TransformResult {
  transform: MarkupTransform;
  output: string;
}

/** A number with an optional sign, decimals and a short unit: 6.5, 40%, 1.5x, +5, 0.9x. */
const value = String.raw`[+-]?\d+(?:\.\d+)?(?:%|x|s)?`;
const pair = new RegExp(String.raw`(?<![\w.])(${value}) +\[(${value})\]`, 'g');
const bareNumber = new RegExp(String.raw`^\s*(${value})\s*$`);
const bracketed = new RegExp(String.raw`^\s*\[(${value})\]\s*$`);
const valueList = new RegExp(String.raw`^\s*${value}(?:\s*,\s*${value}){1,}\s*$`);

const hasMarkup = (text: string) => /[<>]|\/>|#[a-zA-Z0-9]|\$\{/.test(text);

/** Applies a single-line rule to every line; null when no line changed. */
function perLine(input: string, rule: (line: string) => string | null): string | null {
  if (hasMarkup(input)) return null;
  let changed = false;
  const output = input
    .split('\n')
    .map((line) => {
      const result = rule(line);
      if (result === null) return line;
      changed = true;
      return result;
    })
    .join('\n');
  return changed ? output : null;
}

const iconNames = new Map(markupIcons.map((name) => [name.toLowerCase(), name]));

export const markupTransforms: readonly MarkupTransform[] = [
  {
    id: 'pair',
    label: 'X [Y] to PvE and PvP',
    about: 'The first value becomes the PvE tag and the bracketed value the PvP tag.',
    usage: /<pve [^<>]*\/>\s*<pvp /,
    apply: (input) =>
      perLine(input, (line) => {
        const matches = [...line.matchAll(pair)];
        if (matches.length !== 1) return null;
        const [match] = matches;
        return line.replace(match![0], `<pve ${match![1]} /> <pvp [${match![2]}] />`);
      }),
  },
  {
    id: 'number-pve',
    label: 'Number to PvE value',
    about: 'Wraps a plain number in a PvE tag.',
    usage: /<pve /,
    apply: (input) =>
      perLine(input, (line) => {
        const match = bareNumber.exec(line);
        return match ? `<pve ${match[1]} />` : null;
      }),
  },
  {
    id: 'bracket-pvp',
    label: '[n] to PvP value',
    about: 'Wraps a bracketed number in a PvP tag.',
    usage: /<pvp /,
    apply: (input) =>
      perLine(input, (line) => {
        const match = bracketed.exec(line);
        return match ? `<pvp [${match[1]}] />` : null;
      }),
  },
  {
    id: 'element-icon',
    label: 'Word to icon and word',
    about: 'An element, ammo, champion or class word gets its icon in front.',
    usage: /<(?:kinetic|arc|solar|void|stasis|strand|heavy|primary|special)\/>/,
    apply: (input) => {
      const word = input.trim();
      const name = iconNames.get(word.toLowerCase());
      if (!name || hasMarkup(word) || word.includes('\n')) return null;
      return `<${name}/>${word}`;
    },
  },
  {
    id: 'pipe-list',
    label: 'Comma list to pipe list',
    about: 'Values separated by commas become one value per Stack, separated by pipes.',
    usage: /\d\|\d/,
    apply: (input) =>
      perLine(input, (line) =>
        valueList.test(line)
          ? line
              .trim()
              .split(/\s*,\s*/)
              .join('|')
          : null,
      ),
  },
  {
    id: 'title-reference',
    label: 'Term to title reference',
    about: 'A term that names an existing title becomes a hover reference to it.',
    usage: /<title /,
    apply: (input, context) => {
      const term = input.trim();
      if (!term || term.includes('\n') || hasMarkup(term) || /[[\]]/.test(term)) return null;
      const lower = term.toLowerCase();
      const names = new Set(context.titles ?? []);
      const exact = [...names].filter((name) => name.toLowerCase() === lower);
      const global = [...names].filter((name) => name.toLowerCase() === `g_${lower}`);
      // An exact title name wins; otherwise exactly one G_ title; two candidates are ambiguous.
      const candidates = exact.length ? exact : global;
      return candidates.length === 1 ? `<title ${term} [${candidates[0]}] />` : null;
    },
  },
];

/** The transforms that apply to a selection, each with its result. Empty for an empty selection. */
export function applicableTransforms(
  selection: string,
  context: TransformContext = {},
): TransformResult[] {
  if (!selection.trim()) return [];
  return markupTransforms.flatMap((transform) => {
    const output = transform.apply(selection, context);
    return output === null || output === selection ? [] : [{ transform, output }];
  });
}
