import { parseMarkup } from './parse.js';
import { specializeWeaponTypes } from './specialize.js';
import { markupWeaponTypes } from './syntax.js';
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
  const labels = Object.fromEntries([...markupWeaponTypes, 'other'].map((name) => [name, marker]));
  const shown = new Map<string, string>([['diagnostics', JSON.stringify(diagnostics)]]);
  for (const type of markupWeaponTypes) {
    shown.set(type, JSON.stringify(specializeWeaponTypes(lines, { type })));
  }
  const labelled = JSON.stringify(specializeWeaponTypes(lines, { labelled: labels }));
  shown.set('all types', labelled.replace(/(?:\\u0000(?:, )?)+:/g, 'label:'));
  return shown;
}

/** The first way `candidate` differs from `source`, or undefined when they render alike. */
function difference(source: string, candidate: string): string | undefined {
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
  // Preparation can hide authored blocks, so their equivalence cannot be proved here.
  const uncommented = text
    .replace(/\r/g, '')
    .replace(/\/\*[^]*\*\/\n?/g, '')
    .replace(/^ *?\/\/.*$\n?| +\/\/.*$/gm, '');
  if (
    /^(?:enhanced|catalyst|exotic perk|export(?: hidden)? .+|title .+) \(/m.test(text) ||
    /^(?:enhanced|catalyst|exotic perk|export(?: hidden)? .+|title .+) \(/m.test(uncommented)
  )
    return fail('conditional, exported or title content cannot be safely verified');
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
    reason = difference(text, rewrite.text) ?? '';
    if (!reason) return { text: rewrite.text };
  }
  return fail(reason, hasWeaponsOther(text));
}

/** Convenience form of {@link convertWeaponTypeSyntax}: the converted text, or the original. */
export function migrateWeaponTypeSyntax(text: string): string {
  return convertWeaponTypeSyntax(text).text;
}
