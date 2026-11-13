import { stableStringify } from '../contentHash.js';
import { languages, type Lang } from '../languages.js';
import type { Tooltip } from '../schemas.js';

/**
 * A field name exactly as merge3 reports it (packages/core/src/merge3.ts): `text.<lang>` per
 * language, `associated`, and every other top-level Tooltip key (`custom`, `archive`,
 * `compendium`, `legacy`, `bungieSnapshot`, and any key added later). `hash` is identity, never a
 * field.
 */
export type TooltipField =
  | `text.${Lang}`
  | 'associated'
  | Exclude<keyof Tooltip, 'text' | 'associated' | 'hash'>
  | (string & {});

const textPrefix = 'text.';

/** A translation field is `text.<lang>` for any language except English (Q4, approvedDigest). */
export function isTranslationField(field: string): boolean {
  return field.startsWith(textPrefix) && field !== 'text.en';
}

const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : stableStringify(a) === stableStringify(b);

/**
 * merge3's stamped rule: a text entry or a Bungie snapshot is the same value when its content
 * (the text, the description) is the same, whatever its stamps (`updatedAt`, `updatedBy`,
 * `sourceUpdatedAt`, `snapshotAt`). The save enrichers move those stamps only with the content,
 * so a difference in stamps alone is a no-op.
 */
function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (field.startsWith(textPrefix))
    return (a as { text: string }).text === (b as { text: string }).text;
  if (field === 'bungieSnapshot')
    return (
      (a as { description: string }).description === (b as { description: string }).description
    );
  return equal(a, b);
}

/** The value of `field` in `tooltip` (undefined when absent). */
export function fieldValue(tooltip: Tooltip, field: string): unknown {
  if (field.startsWith(textPrefix)) return tooltip.text[field.slice(textPrefix.length) as Lang];
  if (field === 'hash') throw new Error('hash is not a field');
  return (tooltip as Record<string, unknown>)[field];
}

/** `target` with `field` replaced by `source`'s value (removed when `source` lacks it). */
export function withField(target: Tooltip, source: Tooltip, field: string): Tooltip {
  if (field === 'hash') throw new Error('hash is not a field');
  if (field.startsWith(textPrefix)) {
    const lang = field.slice(textPrefix.length) as Lang;
    if (!(languages as readonly string[]).includes(lang)) throw new Error(`Unknown field ${field}`);
    const text = { ...target.text };
    const value = source.text[lang];
    if (value === undefined) delete text[lang];
    else text[lang] = value;
    return { ...target, text };
  }
  if (field === 'associated') return { ...target, associated: [...source.associated] };
  const next: Record<string, unknown> = { ...target };
  const value = (source as Record<string, unknown>)[field];
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next as Tooltip;
}

function emptyLike(hash: number): Tooltip {
  return { hash, text: {}, associated: [] };
}

/**
 * The batch-changed field set (spec "Data model", R17): every field merge3 merges where `base`
 * and `proposed` differ, stamps ignored per merge3's stamped rule. A member added as a new
 * tooltip (`base` null) changes every field `proposed` carries. Order: languages in
 * consumer order, then `associated`, then the other keys sorted.
 *
 * This ONE set drives save validation, no-op detection, approvedDigest, composition, and
 * activation.
 */
export function changedFields(base: Tooltip | null, proposed: Tooltip): string[] {
  const from = base ?? emptyLike(proposed.hash);
  if (from.hash !== proposed.hash) throw new Error('Cannot compare different tooltip hashes');
  const fields: string[] = [];
  for (const lang of languages) {
    const field = `${textPrefix}${lang}`;
    if (!sameValue(field, from.text[lang], proposed.text[lang])) fields.push(field);
  }
  if (!equal(from.associated, proposed.associated)) fields.push('associated');
  const keys = new Set([...Object.keys(from), ...Object.keys(proposed)]);
  for (const key of [...keys].sort()) {
    if (key === 'hash' || key === 'text' || key === 'associated') continue;
    if (!sameValue(key, fieldValue(from, key), fieldValue(proposed, key))) fields.push(key);
  }
  return fields;
}

/** The fields of `changedFields` that are not translations (English included). */
export function nonTranslationChanges(base: Tooltip | null, proposed: Tooltip): string[] {
  return changedFields(base, proposed).filter((field) => !isTranslationField(field));
}

/** `tooltip` without its translations: every key approvedDigest and contentRevision bind. */
export function withoutTranslations(tooltip: Tooltip): Tooltip {
  return { ...tooltip, text: tooltip.text.en ? { en: tooltip.text.en } : {} };
}
