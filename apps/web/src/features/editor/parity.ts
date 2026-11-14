import {
  elementTagNames,
  findElementTags,
  markupCommentContext,
  markupIcons,
  variableReferencePattern,
} from '@clarity/core';

/**
 * Translation parity (TR1, owner 2026-11-09): what the English text has that the translation
 * lacks. Icons, variables, numbers, and lines; a warning only, never a save block. Each rule
 * counts the same thing on both sides and reports the English items the translation has fewer
 * of. Runs in the diagnostics worker with the rest of the checks (diagnosticRequest.ts).
 */
export type ParityKind = 'lines' | 'icon' | 'variable' | 'number';

export interface ParityGap {
  kind: ParityKind;
  /** What is counted: the icon or variable name, the number's value, or "lines". */
  key: string;
  english: number;
  translation: number;
}

/** Declaration and block lines: structure, not prose (their numbers are not the reader's). */
const structureLine =
  /^[ \t]*(?:var\s.*|import\s.*|(?:export(?:\s+hidden)?|title)\s.*\(\s*|enhanced\s*\(\s*|catalyst\s*\(\s*|exotic perk\s*\(\s*|\)\s*)$/;
const icons: ReadonlySet<string> = new Set([...markupIcons, 'enhanced']);
const iconToken = /<([a-z]+)\/>/g;
const legacyArrow = /#e(?![a-zA-Z0-9{])/g;
const mathPattern = /\$\{[^}\n]*\}/g;
const inlineToken = /<.+?\/>/g;
// Digits glued to letters still count (2x, x2, 10s); variable names are removed first.
const numberPattern = /(?<![\d.,])\d+(?:[.,]\d+)?/g;

/** The text the reader sees as prose lines: comments and structure lines removed. */
function proseLines(text: string): string[] {
  return markupCommentContext(text.normalize('NFKC'))
    .text.split('\n')
    .filter((line) => line.trim() !== '' && !structureLine.test(line));
}

function count<T>(values: Iterable<T>): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function iconsOf(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(iconToken)) if (icons.has(match[1]!)) found.push(match[1]!);
    for (const tag of findElementTags(line)) found.push(tag.element);
    found.push(...Array.from(line.matchAll(legacyArrow), () => 'enhanced'));
  }
  return found;
}

function variablesOf(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines)
    for (const match of line.matchAll(variableReferencePattern)) {
      const name = match[1] ?? match[2]!;
      // `#e` is the enhanced arrow (counted with the icons), not a variable.
      if (name !== 'e') found.push(name);
    }
  return found;
}

const elementTag = new RegExp(`^<(?:${elementTagNames.join('|')}) (.*) />$`);

/**
 * The numbers a reader sees: outside tags, maths, and variable names. A decimal comma reads as a
 * point, so "1,5" in a translation matches "1.5" in English.
 *
 * Number tokens (owner 2026-11-14, spec "Number tokens spec") will replace this rule: translators
 * will insert the English numbers as tokens. Swap this one function (and its row in `rules`).
 */
export function numbersOf(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const prose = line
      .replace(inlineToken, (token) => ` ${elementTag.exec(token)?.[1] ?? ''} `)
      .replace(mathPattern, ' ')
      .replace(variableReferencePattern, ' ');
    for (const match of prose.matchAll(numberPattern))
      found.push(String(Number(match[0].replace(',', '.'))));
  }
  return found;
}

const rules: readonly [Exclude<ParityKind, 'lines'>, (lines: readonly string[]) => string[]][] = [
  ['icon', iconsOf],
  ['variable', variablesOf],
  ['number', numbersOf],
];

/**
 * Gaps where the translation has fewer of something than the English. Nothing is checked until
 * the translation has text (an empty translation is untranslated, not incomplete).
 */
export function translationParity(english: string, translation: string): ParityGap[] {
  if (!/\S/.test(translation) || !/\S/.test(english)) return [];
  const source = proseLines(english);
  const target = proseLines(translation);
  const gaps: ParityGap[] = [];
  if (target.length < source.length)
    gaps.push({
      kind: 'lines',
      key: 'lines',
      english: source.length,
      translation: target.length,
    });
  for (const [kind, rule] of rules) {
    const theirs = count(rule(target));
    for (const [key, english] of count(rule(source))) {
      const translation = theirs.get(key) ?? 0;
      if (translation < english) gaps.push({ kind, key, english, translation });
    }
  }
  return gaps;
}

/** One line per gap, for the status panel and the item's title. */
export function describeGap(gap: ParityGap): string {
  const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  switch (gap.kind) {
    case 'lines':
      return `English has ${gap.english} lines; the translation has ${gap.translation}.`;
    case 'icon': {
      const icon = gap.key === 'enhanced' ? 'The enhanced arrow' : `Icon <${gap.key}/>`;
      return gap.translation === 0
        ? `${icon} is missing.`
        : `${icon} appears ${times(gap.english)} in English, ${times(gap.translation)} here.`;
    }
    case 'variable':
      return gap.translation === 0
        ? `Variable #${gap.key} is missing.`
        : `Variable #${gap.key} appears ${times(gap.english)} in English, ${times(gap.translation)} here.`;
    case 'number':
      return gap.translation === 0
        ? `Number ${gap.key} is missing.`
        : `Number ${gap.key} appears ${times(gap.english)} in English, ${times(gap.translation)} here.`;
  }
}
