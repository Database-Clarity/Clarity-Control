import { parseMarkup } from './parse.js';
import {
  markupConditions,
  markupImports,
  markupVariableReferences,
  normalizeMarkupWhitespace,
  prepareMarkup,
  removeMarkupComments,
} from './prepare.js';
import { specializeWeaponTypes } from './specialize.js';
import { extractBlocks, markupWeaponTypes } from './syntax.js';
import type { MarkupDiagnostic } from './types.js';
import {
  hasOldWeaponTypeSyntax,
  hasWeaponsOther,
  rewriteWeaponTypeSyntax,
  validateWeaponSections,
} from './weapons.js';

export interface WeaponConversion {
  /** The converted text, or the original text when nothing was (or could safely be) converted. */
  text: string;
  /** Why an old-syntax text was left unchanged; absent when converted or nothing to convert. */
  diagnostic?: string;
}

/**
 * Everything a reader can see of `text`: each weapon type's specialised lines and the labelled
 * all-types view, built with the real prepare → parse → specialise pipeline. Labels are blanked to
 * one marker, so only the block structure and content count: an old per-chain `other` that is
 * written as an explicit type list is labelled differently but shows the same text.
 */
function renderings(text: string): Map<string, string> {
  const { lines, diagnostics } = parseMarkup(text);
  const marker = String.fromCharCode(0);
  const labels = Object.fromEntries([...markupWeaponTypes, 'other'].map((name) => [name, { en: marker }]));
  const shown = new Map<string, string>([['diagnostics', JSON.stringify(diagnostics)]]);
  for (const type of markupWeaponTypes) {
    shown.set(type, JSON.stringify(specializeWeaponTypes(lines, { type })));
  }
  const labelled = JSON.stringify(specializeWeaponTypes(lines, { labelled: labels }));
  shown.set('all types', labelled.replace(/(?:\\u0000(?:, )?)+:/g, 'label:'));
  return shown;
}

/**
 * Prove preparation is context independent before comparing visible output. External dependencies
 * are refused using production's own expansion recognisers on RAW text: expansion runs before
 * comment removal, so even a commented reference can change comment scope. For dependency-free
 * text, execute every production conditional context and require only comment/whitespace changes.
 * Reusable definitions are refused using production extraction, whether currently consumed or not.
 */
function hasOpaqueContent(text: string): boolean {
  if (markupVariableReferences(text).length || markupImports(text).length) return true;
  if (Object.keys(extractBlocks(text, 'export')).length) return true;
  const transparent = normalizeMarkupWhitespace(removeMarkupComments(text.trim()));
  for (const type of [undefined, ...markupConditions.map(([, type]) => type)]) {
    const diagnostics: MarkupDiagnostic[] = [];
    const prepared = prepareMarkup(text, { variables: '', titles: '', type }, diagnostics);
    if (
      diagnostics.length > 0 ||
      prepared.text !== transparent ||
      Object.keys(prepared.titles).length > 0 ||
      Object.keys(extractBlocks(prepared.text, 'export')).length > 0
    )
      return true;
  }
  return false;
}

/** The first way `candidate` differs from `source`, or undefined when they render alike. */
function difference(source: string, candidate: string): string | undefined {
  if (hasOpaqueContent(source) || hasOpaqueContent(candidate))
    return 'conditional, exported, title or expanded content (including variable/import references inside comments) cannot be safely verified';
  const error = validateWeaponSections(candidate).find((issue) => issue.severity === 'error');
  const comments = (text: string) => text.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g) ?? [];
  if (JSON.stringify(comments(source)) !== JSON.stringify(comments(candidate)))
    return 'a comment would be lost or changed';
  if (error) return `the result would not validate (line ${error.line}: ${error.message})`;
  const before = renderings(source);
  const after = renderings(candidate);
  for (const [name, content] of before) {
    if (after.get(name) !== content) {
      return name === 'diagnostics'
        ? 'the result would report different markup diagnostics'
        : `the ${name === 'all types' ? 'all-types view' : name} rendering would change`;
    }
  }
  return undefined;
}

/**
 * Converts old `< weapon type (…) >` blocks to `<weapons …>` blocks, but only when that is
 * lossless: every weapon type's rendering, the all-types view and validation must agree between
 * the old text and the result. Otherwise the text is returned unchanged with a `diagnostic`
 * saying why, so nothing is ever dropped or silently altered. Idempotent.
 */
export function convertWeaponTypeSyntax(text: string): WeaponConversion {
  if (!hasOldWeaponTypeSyntax(text)) return { text };
  const fail = (reason: string, mixed = false): WeaponConversion => ({
    text,
    diagnostic: `The old weapon-type syntax was not converted: ${reason}.${
      mixed ? ' Mixed old and new fallback: this text already has a <weapons other> block.' : ''
    } Edit the text by hand to use <weapons …> blocks.`,
  });
  let reason = '';
  // Trailing comments stay in place when that renders the same, else move to their own line.
  for (const ownLines of [false, true]) {
    const rewrite = rewriteWeaponTypeSyntax(text, ownLines);
    if ('problem' in rewrite) return fail(rewrite.problem.replace(/\.$/, ''));
    if (rewrite.text === text) {
      return fail(
        'no complete old block was found; each needs a header like "< weapon type ( … ) >" and a closing <$$> line',
      );
    }
    try {
      reason = difference(text, rewrite.text) ?? '';
    } catch {
      return fail('the markup evaluator could not prove that all content is preserved');
    }
    if (!reason) return { text: rewrite.text };
  }
  return fail(reason, hasWeaponsOther(text));
}

/** Convenience form of {@link convertWeaponTypeSyntax}: the converted text, or the original. */
export function migrateWeaponTypeSyntax(text: string): string {
  return convertWeaponTypeSyntax(text).text;
}
