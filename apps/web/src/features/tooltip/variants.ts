import { languages, parseMarkup, type Lang, type MarkupGlobals } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
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

const forms = new WeakMap<EditorData, Map<string, VariantForm>>();

/** Memoised per data bundle: the page and the preview ask on every render. */
export function variantForm(base: number, variant: number, data: EditorData): VariantForm {
  let cache = forms.get(data);
  if (!cache) forms.set(data, (cache = new Map()));
  const key = `${base}:${variant}`;
  let form = cache.get(key);
  if (!form) {
    form = languages.every((lang) => variantMatchesBase(base, variant, lang, data))
      ? 'derived'
      : 'override';
    cache.set(key, form);
  }
  return form;
}

/** The variants of `base` that keep text of their own ("Edit override"), in catalog order. */
export function overrideVariants(base: number, data: EditorData): number[] {
  return enhancedVariants(base, data).filter(
    (variant) => variantForm(base, variant, data) === 'override',
  );
}

export interface EnhancedRender {
  text: string;
  type: string | undefined;
  form: VariantForm;
}

const renders = new WeakMap<EditorData, WeakMap<Drafts, Map<string, EnhancedRender>>>();
const noDrafts: Drafts = {};

/**
 * What the variant shows in `lang`: derived variants are the base text read with the variant's
 * own type; overrides keep their own text and type. Unsaved drafts count (the preview must show
 * what the editor holds), and the result is cached per data bundle and drafts snapshot, so the
 * page can ask on every render. Whether a variant is derived stays a property of the stored data:
 * typing in the base never turns a derived version into an override.
 */
export function enhancedRender(
  base: number,
  variant: number,
  lang: Lang,
  data: EditorData,
  drafts: Drafts = noDrafts,
): EnhancedRender {
  let byDrafts = renders.get(data);
  if (!byDrafts) renders.set(data, (byDrafts = new WeakMap()));
  let cache = byDrafts.get(drafts);
  if (!cache) byDrafts.set(drafts, (cache = new Map()));
  const key = `${base}:${variant}:${lang}`;
  let result = cache.get(key);
  if (!result) {
    const form = variantForm(base, variant, data);
    const textOf = (hash: number) =>
      (drafts[hash]?.next ?? tooltipFor(hash, data)).text[lang]?.text ?? '';
    result = {
      text: form === 'derived' ? textOf(base) : textOf(variant),
      type: legacyTypeOf(variant, data),
      form,
    };
    cache.set(key, result);
  }
  return result;
}

/**
 * A real base -> enhanced pair: the variant's category is its base's category plus " Enhanced"
 * ("Weapon Trait" -> "Weapon Trait Enhanced"). Weapon-perk copies, exotic frames and origin traits
 * are variants too, but they are not enhanced versions of anything and carry no enhanced mark.
 */
export function isEnhancedPair(base: number, variant: number, data: EditorData): boolean {
  if (isEnhancedCategoryPair(base, variant, data)) return true;
  const type = legacyTypeOf(variant, data);
  const baseType = legacyTypeOf(base, data);
  return Boolean(type && baseType && type === `${baseType} Enhanced`);
}

/**
 * Enhanced parts, origin traits, and mods share the "Weapon Trait Enhanced" export type.
 * Use their generator-linked base categories instead (mods can belong to parts too).
 * The generator resolves name, plug category, and socket-context ambiguity; never infer a link here.
 */
const enhancedCategoryPairs: Readonly<Record<string, readonly string[]>> = {
  'weapon-perk-enhanced': ['weapon-perk'],
  'weapon-trait-origin-enhanced': ['weapon-trait-origin'],
  'weapon-mod-enhanced': ['weapon-mod', 'weapon-perk'],
};
function isEnhancedCategoryPair(base: number, variant: number, data: EditorData): boolean {
  const variantCategory = data.items[variant]?.categoryId;
  return (
    variantCategory !== undefined &&
    variantCategory in enhancedCategoryPairs &&
    enhancedCategoryPairs[variantCategory]!.includes(data.items[base]?.categoryId ?? '')
  );
}

/** The enhanced versions of a base proper, for the finder's mark and the Base | Enhanced views. */
export function enhancedPairs(hash: number, data: EditorData): number[] {
  const base = canonicalHash(hash, data);
  return enhancedVariants(base, data).filter((variant) => isEnhancedPair(base, variant, data));
}

/**
 * A same-name copy with no text in any language while its base has some. These are being turned
 * into alias groups (separate design), so no override UI is offered for them.
 */
export function isBlankCopy(base: number, variant: number, data: EditorData): boolean {
  const blank = languages.every((lang) => ownText(variant, lang, data).trim() === '');
  return blank && languages.some((lang) => baseText(base, lang, data).trim() !== '');
}

/** Variants with text of their own that an "Edit override" can open; blank copies are left out. */
export function editableOverrides(base: number, data: EditorData): number[] {
  return overrideVariants(base, data).filter((variant) => !isBlankCopy(base, variant, data));
}

/** What the page previews next to the base: real enhanced pairs and editable overrides. */
export function previewedVariants(base: number, data: EditorData): number[] {
  const overrides = new Set(editableOverrides(base, data));
  return enhancedVariants(base, data).filter(
    (variant) => overrides.has(variant) || isEnhancedPair(base, variant, data),
  );
}

const enhancedCategories = new WeakMap<EditorData, ReadonlySet<string>>();

/** Category scope comes from real catalogue pairs, including both ends of each pair. */
export function categoriesWithEnhanced(data: EditorData): ReadonlySet<string> {
  let categories = enhancedCategories.get(data);
  if (!categories) {
    const found = new Set<string>();
    for (const item of Object.values(data.items)) {
      const base = canonicalHash(item.hash, data);
      if (base === item.hash || !isEnhancedPair(base, item.hash, data)) continue;
      const baseCategory = data.items[base]?.categoryId;
      if (baseCategory) found.add(baseCategory);
      found.add(item.categoryId);
    }
    categories = found;
    enhancedCategories.set(data, categories);
  }
  return categories;
}
