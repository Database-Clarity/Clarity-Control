import { languages, parseMarkup, type Lang, type MarkupGlobals } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { tooltipImports } from '../../services/tooltipImports';
import { canonicalHash, tooltipFor, variantHashes } from '../navigation/catalog';

/**
 * Variant model D. A base tooltip owns one editor; its variants (enhanced versions) are either
 * `derived` — the variant's stored text already renders, in every language, exactly like the BASE
 * text rendered with the variant's own category type (which is how an `enhanced (` block and `#e`
 * survive only for 'Weapon Trait Enhanced') — or an `override`, which has text of its own.
 * Read-only: nothing here writes data or changes what is exported.
 */
export type VariantForm = 'derived' | 'override';

/** The variants of a base (its enhanced versions), without the base itself. */
export function enhancedVariants(hash: number, data: EditorData): number[] {
  const base = canonicalHash(hash, data);
  return variantHashes(base, data).filter((variant) => variant !== base);
}

function legacyTypeOf(variant: number, data: EditorData): string | undefined {
  const categoryId = data.items[variant]?.categoryId;
  return data.categories.find((category) => category.id === categoryId)?.legacyType;
}

const importCatalogs = new WeakMap<EditorData, Map<Lang, Record<string, string>>>();
function importsFor(data: EditorData, lang: Lang): Record<string, string> {
  let catalogs = importCatalogs.get(data);
  if (!catalogs) importCatalogs.set(data, (catalogs = new Map()));
  let imports = catalogs.get(lang);
  if (!imports) {
    imports = tooltipImports(data.bundle.tooltips, {}, lang, data.aliases);
    catalogs.set(lang, imports);
  }
  return imports;
}

function globalsFor(variant: number, lang: Lang, data: EditorData): MarkupGlobals {
  const imports = importsFor(data, lang);
  return {
    variables: imports[2] ?? '',
    titles: imports[3] ?? '',
    imports,
    type: legacyTypeOf(variant, data),
  };
}

function rendered(text: string, globals: MarkupGlobals): string {
  return JSON.stringify(parseMarkup(text, globals).lines);
}

/** The base text a variant would render when derived, in `lang`. */
function baseText(base: number, lang: Lang, data: EditorData): string {
  return tooltipFor(base, data).text[lang]?.text ?? '';
}

function ownText(variant: number, lang: Lang, data: EditorData): string {
  return tooltipFor(variant, data).text[lang]?.text ?? '';
}

/** Whether the stored text renders like the base text in `lang`; both empty counts as equal. */
export function variantMatchesBase(
  base: number,
  variant: number,
  lang: Lang,
  data: EditorData,
): boolean {
  const own = ownText(variant, lang, data);
  const inherited = baseText(base, lang, data);
  if (own === inherited) return true;
  const globals = globalsFor(variant, lang, data);
  return rendered(own, globals) === rendered(inherited, globals);
}

export function variantForm(base: number, variant: number, data: EditorData): VariantForm {
  return languages.every((lang) => variantMatchesBase(base, variant, lang, data))
    ? 'derived'
    : 'override';
}

/**
 * What the variant shows in `lang`: derived variants are the base text read with the variant's
 * own type; overrides keep their own text and type.
 */
export function enhancedRender(
  base: number,
  variant: number,
  lang: Lang,
  data: EditorData,
): { text: string; type: string | undefined; form: VariantForm } {
  const form = variantForm(base, variant, data);
  return {
    text: form === 'derived' ? baseText(base, lang, data) : ownText(variant, lang, data),
    type: legacyTypeOf(variant, data),
    form,
  };
}
