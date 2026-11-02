import { glyphPolicy } from './glyph-policy.js';

export interface GlyphWarning {
  character: string;
  codePoint: string;
  from: number;
  to: number;
  reason: string;
  replacement?: string;
  message: string;
}

// A single compiled regexp skips runs of vetted characters, including ASCII.
const escape = (text: string) => text.replace(/[\\\][\-^]/g, '\\$&');
const allowed =
  glyphPolicy.ranges
    .map(([a, b]) => `${escape(String.fromCodePoint(a))}-${escape(String.fromCodePoint(b))}`)
    .join('') + escape(glyphPolicy.characters);
const unverified = new RegExp(`[^${allowed}]`, 'gu');

/** An ASCII arrow's > must not accidentally close a markup tag. */
export function canReplaceGlyph(text: string, warning: GlyphWarning): boolean {
  if (warning.replacement === undefined) return false;
  if (!/[<>]/.test(warning.replacement)) return true;
  const prefix = text.slice(text.lastIndexOf('\n', warning.from - 1) + 1, warning.from);
  return prefix.lastIndexOf('<') <= prefix.lastIndexOf('>');
}

export function glyphWarnings(text: string): GlyphWarning[] {
  const warnings: GlyphWarning[] = [];
  for (const match of text.matchAll(unverified)) {
    const character = match[0];
    const codePoint = `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
    const known = glyphPolicy.knownRisk[character];
    const reason =
      known?.reason ??
      'Font coverage is unverified; this character may not display on some devices.';
    const replacement = known?.replacement;
    const label = /\p{C}|\p{Z}/u.test(character) ? '(invisible)' : `“${character}”`;
    warnings.push({
      character,
      codePoint,
      from: match.index,
      to: match.index + character.length,
      reason,
      replacement,
      message: `${label} ${codePoint}: ${reason}${replacement ? ` Suggested replacement: ${replacement}.` : ''}`,
    });
  }
  return warnings;
}
