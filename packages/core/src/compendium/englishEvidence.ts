import { lowerConsumerMarkup } from '../markup/braces.js';
import { markupImports } from '../markup/prepare.js';

/**
 * Presentation-only differences between two pieces of evidence text, shared by owner
 * text and Compendium cell text (root brief MATCHER-EVIDENCE, 2026-11-19).
 *
 * Markup forms every consumer lowers identically (element tags, delimited variables,
 * `<exotic>` = `<yellow>`, the arrow symbol and its `<arrow/>` token) are lowered here.
 * Visible formatting is folded: line breaks, whitespace runs, dashes, quotes and
 * apostrophes, and zero-width characters. Wording, numbers and symbols are never
 * changed, so a real edit still differs.
 */
export function normaliseEvidenceFormatting(text: string): string {
  const lowered = lowerConsumerMarkup(text, 'legacy');
  return lowered
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// Compendium approval equivalence only; never use for publication or source hashes.
export function normaliseCompendiumEnglish(text: string): string {
  if (!text.includes('<enhanced/>')) return text;
  const imports = markupImports(text).length > 0;
  const numericVariable = /^\s*var\s+e\d\w*\s*=/m.test(text);
  return text.replace(/<enhanced\/>(?![a-zA-Z])/g, (tag, offset: number) => {
    // Historical #eN arrows exist, but imports can supply a user variable.
    // Without resolving the import closure, numeric equivalence must fail closed.
    const number = /^\d+/.exec(text.slice(offset + tag.length))?.[0];
    return number && (imports || numericVariable) ? tag : '#e';
  });
}
