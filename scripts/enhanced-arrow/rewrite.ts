// ENHANCED-ARROW: the legacy arrow `#e` becomes the arrow symbol `<enhanced/>` (owner 2026-11-14
// "Rewrite now"). Pure planning and census: no I/O here, so the CLI and the tests share every rule.
//
// Rewritten: `#e` not followed by a letter or digit (a longer name such as `#element` is another
// variable). Left alone, and listed with the reason: an `#e` inside a comment (its meaning is the
// author's note, not markup), inside a URL or a link target, or right after a letter or digit
// (inside a word). Every exporter lowers `<enhanced/>` back to `#e` (core braces.ts), so the
// rewritten text exports byte for byte what the stored text exports today.
import {
  enhancedArrowMarkup,
  extractVariables,
  legacyArrowPattern,
  lowerDelimitedMarkup,
  markupCommentContext,
  mergedVariable,
  variableReferences,
} from '../../packages/core/src/index.js';

export type SkipReason = 'comment' | 'url' | 'word';

export interface ArrowRewrite {
  text: string;
  /** Offsets of every rewritten `#e` in the original text. */
  rewritten: number[];
  skipped: { at: number; reason: SkipReason; line: string }[];
}

const urlRun = /https?:\/\/\S*/g;
/** A link target, `<link text [https://…] />`: the bracketed part of the token. */
const linkTarget = /<link [^\n]*?\[([^\]\n]*)\] ?\/>/g;

function ranges(pattern: RegExp, text: string, group = 0) {
  const found: { from: number; to: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const from = match.index + (group ? match[0].indexOf(match[group]!) : 0);
    found.push({ from, to: from + match[group]!.length });
  }
  return found;
}

const lineAt = (text: string, at: number) =>
  text.slice(
    text.lastIndexOf('\n', at - 1) + 1,
    (text.indexOf('\n', at) + 1 || text.length + 1) - 1,
  );

/** The rewrite of one text: exact, and the identity on text without a rewritable `#e`. */
export function rewriteLegacyArrow(text: string): ArrowRewrite {
  const rewritten: number[] = [];
  const skipped: ArrowRewrite['skipped'] = [];
  if (!text.includes('#e')) return { text, rewritten, skipped };
  const comments = markupCommentContext(text).comments;
  const urls = [...ranges(urlRun, text), ...ranges(linkTarget, text, 1)];
  const inside = (list: { from: number; to: number }[], at: number) =>
    list.some((range) => at >= range.from && at < range.to);
  let out = '';
  let last = 0;
  for (const match of text.matchAll(legacyArrowPattern)) {
    const at = match.index;
    const reason: SkipReason | undefined = inside(comments, at)
      ? 'comment'
      : inside(urls, at)
        ? 'url'
        : /[a-zA-Z0-9]/.test(text[at - 1] ?? '')
          ? 'word'
          : undefined;
    if (reason) {
      skipped.push({ at, reason, line: lineAt(text, at) });
      continue;
    }
    out += text.slice(last, at) + enhancedArrowMarkup;
    last = at + match[0].length;
    rewritten.push(at);
  }
  if (!rewritten.length) return { text, rewritten, skipped };
  const next = out + text.slice(last);
  // Fail closed: the rewrite must lower to exactly what the stored text lowers to (every exporter
  // reads the lowered text, so exports stay byte-identical; stored braces stay as written).
  if (lowerDelimitedMarkup(next) !== lowerDelimitedMarkup(text))
    throw new Error('Rewrite does not lower to the original');
  return { text: next, rewritten, skipped };
}

export interface CensusText {
  hash: number;
  lang: string;
  category: string;
  text: string;
  /** The language's global variables (tooltip 2), for the merge census. */
  globals: string;
}

export interface Census {
  /** Texts and `#e` arrows per language and category. */
  arrows: Record<string, Record<string, { texts: number; lines: number; uses: number }>>;
  skipped: { hash: number; lang: string; reason: SkipReason; line: string }[];
  /** `#e` followed by letters or digits: other variables (`#element`), never rewritten. */
  longerNames: Record<string, number>;
  /**
   * Plain references whose greedy name is undefined while a defined name is its prefix: the
   * editor's "merges with the text after it" warning (braces needed), per language.
   */
  merged: { hash: number; lang: string; reference: string; variable: string; line: string }[];
  /** Local `var e` definitions outside the globals (they would change what the arrow is). */
  localArrowDefinitions: { hash: number; lang: string }[];
}

export function census(texts: readonly CensusText[]): Census {
  const result: Census = {
    arrows: {},
    skipped: [],
    longerNames: {},
    merged: [],
    localArrowDefinitions: [],
  };
  for (const { hash, lang, category, text, globals } of texts) {
    if (hash > 3 && Object.hasOwn(extractVariables(text), 'e'))
      result.localArrowDefinitions.push({ hash, lang });
    const rewrite = rewriteLegacyArrow(text);
    for (const skip of rewrite.skipped)
      result.skipped.push({ hash, lang, reason: skip.reason, line: skip.line });
    if (rewrite.rewritten.length) {
      const row = ((result.arrows[lang] ??= {})[category] ??= { texts: 0, lines: 0, uses: 0 });
      row.texts++;
      row.uses += rewrite.rewritten.length;
      // Source lines, by where they start (two equal lines count twice).
      row.lines += new Set(rewrite.rewritten.map((at) => text.lastIndexOf('\n', at - 1))).size;
    }
    for (const match of text.matchAll(/#e[a-zA-Z0-9]+/g))
      result.longerNames[match[0]] = (result.longerNames[match[0]] ?? 0) + 1;
    const defined = { ...extractVariables(text), ...extractVariables(globals) };
    for (const reference of variableReferences(text)) {
      if (reference.braced) continue;
      const variable = mergedVariable(reference.name, (name) => Object.hasOwn(defined, name));
      if (variable !== undefined)
        result.merged.push({
          hash,
          lang,
          reference: `#${reference.name}`,
          variable,
          line: lineAt(text, reference.from),
        });
    }
  }
  return result;
}
