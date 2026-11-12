// compile(file) -> plan (spec section 3, "Compiler"): seven ordered stages instead of one
// DescriptionFilter. Legacy presets bypass stages 3, 5, and 6 and run the held converter path
// (buildLegacy) byte for byte. Everything else resolves each row exactly as the editor preview
// does (core parseMarkup with the same globals), so base/enhanced pairs, imports, titles, and
// math match the preview, then selects, transforms, and encodes.
import {
  showcaseGlobals,
  showcaseId,
  showcaseName,
  showcaseText,
} from '@clarity/core/markup/showcase';
import { parseMarkup, type MarkupGlobals, type MarkupLine } from '@clarity/core/markup/parse';
import { lowerElementTags } from '@clarity/core/markup/elementTags';
import {
  expandAliases,
  isAliasStub,
  validateReferences,
  type ExpandedPerks,
  type IntermediatePerk,
} from '../converter/index.js';
import { lowerInput } from '../elementTags.js';
import { buildLegacy, type LegacyInput } from '../legacy.js';
import type { ExportFile, StyleFile } from './config.js';
import {
  exportLanguages,
  isLegacyFile,
  itemKeys,
  type ExportLanguage,
  type ItemKey,
} from './vocabulary.js';
import { emptyNotes, transform, type OutLine, type TransformNotes } from './transform.js';

/** Stage names, in order (spec section 3). */
export const compileStages = [
  'resolve',
  'select-rows',
  'select-keys',
  'references',
  'transform',
  'encode',
  'serialise',
] as const;
export type CompileStage = (typeof compileStages)[number];

/**
 * The generator catalog pinned by the publish receipt: `items.json` and `categories.json` of
 * Description-data-generator templates/v2 as they are (only `categoryId` and `id` are read).
 * Passed in by the caller: the engine never fetches anything.
 */
export type Catalog = {
  items: Readonly<Record<string, { categoryId: string } | undefined>>;
  categories: readonly { id: string }[];
};

export type CompileOptions = {
  catalog: Catalog;
  /** Hashes whose English text equals Bungie's description (bungieIdentical). */
  identical?: Iterable<string | number>;
};

export type Descriptions = Partial<Record<ExportLanguage, OutLine[] | string>>;
/** An item of the expanded (per-hash) form, before encoding. */
export type ExpandedItem = { hash: number } & Partial<Record<ItemKey, unknown>> & {
    descriptions: Descriptions;
  };

/** Format v1 file (spec section 7): shared texts, items point at one by index. */
export type FormatV1File = {
  texts: Descriptions[];
  items: Record<string, Partial<Record<ItemKey, unknown>> & { t: number }>;
};

export type Notice =
  | { kind: 'uncategorised'; hashes: number[] }
  | { kind: 'unchosen-symbol'; symbols: string[] }
  | { kind: 'retired-markup'; classNames: string[] }
  | { kind: 'tables-dropped'; count: number }
  | { kind: 'unknown-category'; categories: string[] };

export type Plan = {
  stages: readonly CompileStage[];
  /** Stages the file ran through; legacy presets skip select-keys, transform, and encode. */
  ran: CompileStage[];
  legacy: boolean;
  /** v1 only: the expanded form (what the reference decoder returns). */
  expanded?: Record<string, ExpandedItem>;
  /** v1 only: the encoded file before serialising. */
  file?: FormatV1File;
  bytes: Uint8Array;
  notices: Notice[];
};

const encoder = new TextEncoder();

/** Raw `{{` in any text of the input: a pair the legacy converter cannot express. */
function hasRawPair(input: LegacyInput): boolean {
  return Object.values(input.perks).some(
    (perk) =>
      !isAliasStub(perk) &&
      Object.values(perk.editor).some(
        (text) => text?.main.includes('{{') || text?.secondary.includes('{{'),
      ),
  );
}

/**
 * Builds one file. Throws when the input is invalid (bad aliases or associations), when a
 * tooltip in the file has a markup error the editor reports (unresolved or cyclic import,
 * malformed base/enhanced pair; the message names the hash and language), or when a
 * legacy preset meets base/enhanced markup it cannot express (refused until the owner decides
 * the cut-over output, as the Worker refuses the push).
 */
export function compile(input: LegacyInput, file: ExportFile, options: CompileOptions): Plan {
  // Element-tagged text compiles exactly as its lowered form (`<solar/>Scorch`) written by hand.
  input = lowerInput(input);
  if (isLegacyFile(file)) {
    if (hasRawPair(input))
      throw new Error('Base/enhanced markup needs the new converter; legacy presets refuse it');
    const bytes = buildLegacy(input, file.preset, { identical: options.identical });
    return {
      stages: compileStages,
      ran: ['resolve', 'select-rows', 'references', 'serialise'],
      legacy: true,
      bytes,
      notices: [],
    };
  }
  return compileStyle(input, file, options);
}

/** Globals of one language, built as the editor preview builds them (tooltipImports, variants.ts). */
function globalsOf(lookup: ExpandedPerks, language: ExportLanguage) {
  const imports: Record<string, string> = Object.create(null);
  for (const [hash, perk] of Object.entries(lookup))
    imports[hash] = perk.editor[language]?.main ?? '';
  return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
}

function compileStyle(input: LegacyInput, file: StyleFile, options: CompileOptions): Plan {
  const { data, format, shape } = file;
  const notices: Notice[] = [];
  const ran: CompileStage[] = [];

  // 1 resolve: full database (all rows, reserved globals 1-3, imports, variables, titles,
  // base/enhanced parts). Filters below never change what a row resolves to.
  validateReferences(input.perks);
  const lookup = expandAliases(input.perks);
  const languages = exportLanguages.filter((language) => data.languages.includes(language));
  const globals = new Map(languages.map((language) => [language, globalsOf(lookup, language)]));
  const resolved = new Map<string, Partial<Record<ExportLanguage, MarkupLine[]>>>();
  const resolve = (hash: string, perk: IntermediatePerk) => {
    let rows = resolved.get(hash);
    if (rows) return rows;
    rows = {};
    for (const language of languages) {
      const text = perk.editor[language]?.main;
      if (text === undefined) continue;
      const markupGlobals: MarkupGlobals = { ...globals.get(language)!, type: perk.type };
      const { lines, diagnostics } = parseMarkup(text, markupGlobals);
      // What the editor shows as an error (an unresolved or cyclic import, a malformed
      // base/enhanced pair) is refused, so the file fails as a whole and is carried forward.
      const error = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (error) throw new Error(`Tooltip ${hash} (${language}): ${error.message}`);
      if (lines.length) rows[language] = lines;
    }
    resolved.set(hash, rows);
    return rows;
  };
  ran.push('resolve');

  // 2 row selection: categories, sandbox perks per category, frame aliases, Bungie-identical,
  // languages; always: hash < 50, empty English text.
  const identical = new Set([...(options.identical ?? [])].map(String));
  const knownCategories = new Set(options.catalog.categories.map((category) => category.id));
  const categories = new Set(data.categories);
  const sandbox = new Set(data.sandboxPerks);
  const uncategorised: number[] = [];
  const selected: string[] = [];
  for (const [hash, raw] of Object.entries(input.perks)) {
    const perk = lookup[hash];
    if (perk === undefined || Number(hash) < 50) continue;
    if ((perk.editor.en?.main.trim() ?? '') === '') continue;
    if (!data.bungieIdentical && identical.has(hash)) continue;
    const alias = isAliasStub(raw) ? raw : undefined;
    if (alias?.aliasKind === 'frame' && !data.frameAliases) continue;
    // A sandbox perk has no catalog item of its own: it belongs to the item it is a perk of.
    const owner = alias?.aliasKind === 'sandbox' ? String(alias.aliasOf) : hash;
    const category = options.catalog.items[owner]?.categoryId;
    if (category === undefined || !knownCategories.has(category)) {
      uncategorised.push(Number(hash));
      continue;
    }
    if (!(alias?.aliasKind === 'sandbox' ? sandbox : categories).has(category)) continue;
    const rows = resolve(hash, perk);
    if (!languages.some((language) => rows[language])) continue;
    selected.push(hash);
  }
  if (uncategorised.length)
    notices.push({ kind: 'uncategorised', hashes: uncategorised.sort((a, b) => a - b) });
  ran.push('select-rows');

  // 3 key selection: only the chosen keys, in a fixed order.
  const keys = itemKeys.filter((key) => data.keys.includes(key));
  const picked = new Map<string, Partial<Record<ItemKey, unknown>>>();
  for (const hash of selected) {
    const perk = lookup[hash];
    const item: Partial<Record<ItemKey, unknown>> = {};
    for (const key of keys) {
      if (key === 'updateTracker') {
        const tracker = perk.updateTracker?.descriptions ?? {};
        const descriptions = Object.fromEntries(
          languages.flatMap((language) =>
            tracker[language] ? [[language, tracker[language]]] : [],
          ),
        );
        if (Object.keys(descriptions).length) item.updateTracker = { descriptions };
        continue;
      }
      const value = perk[key as keyof IntermediatePerk];
      if (value !== undefined && value !== '') item[key] = value;
    }
    picked.set(hash, item);
  }
  ran.push('select-keys');

  // 4 reference policy: an associated id whose target is not in this file is dropped. Every
  // selected row, canonical or alias, is its own item (no alias references in v1).
  const inFile = new Set(selected.map(Number));
  for (const item of picked.values()) {
    if (!Array.isArray(item.associated)) continue;
    const kept = (item.associated as number[]).filter((target) => inFile.has(target));
    if (kept.length) item.associated = kept;
    else delete item.associated;
  }
  ran.push('references');

  // 5 symbol transforms for the file's shape.
  const notes: TransformNotes = emptyNotes();
  const expanded: Record<string, ExpandedItem> = {};
  for (const hash of selected) {
    const rows = resolved.get(hash)!;
    const descriptions: Descriptions = {};
    for (const language of languages) {
      const lines = rows[language];
      if (lines) descriptions[language] = transform(lines, format, shape, notes);
    }
    expanded[hash] = { hash: Number(hash), ...picked.get(hash), descriptions };
  }
  if (data.includeShowcase) {
    const descriptions: Descriptions = {};
    // Match lowerInput's consumer representation, including its removal of preview-only tint.
    const { lines, diagnostics } = parseMarkup(lowerElementTags(showcaseText), showcaseGlobals);
    if (diagnostics.length) throw new Error('Invalid built-in showcase markup');
    // English example in each selected language: self-contained, never translated by data.
    for (const language of languages)
      descriptions[language] = transform(lines, format, shape, notes);
    expanded[showcaseId] = {
      hash: Number(showcaseId),
      ...(keys.includes('name') ? { name: showcaseName } : {}),
      descriptions,
    };
  }
  if (notes.unchosen.size)
    notices.push({ kind: 'unchosen-symbol', symbols: [...notes.unchosen].sort() });
  if (notes.retired.size)
    notices.push({ kind: 'retired-markup', classNames: [...notes.retired].sort() });
  if (notes.tables) notices.push({ kind: 'tables-dropped', count: notes.tables });
  ran.push('transform');

  // 6 encoding (section 7): shared texts, chosen keys only.
  const encoded = encodeV1(expanded);
  ran.push('encode');

  // 7 serialise: minified JSON, UTF-8, after checking every `t` and association resolves.
  validateV1(encoded);
  const bytes = encoder.encode(JSON.stringify(encoded));
  ran.push('serialise');

  return { stages: compileStages, ran, legacy: false, expanded, file: encoded, bytes, notices };
}

/**
 * Encodes the expanded form as format v1: every distinct `descriptions` value is stored once in
 * `texts` (first use first), and each item names it by index `t`. Items keep their keys minus
 * `hash` (the object key) and `descriptions`.
 */
export function encodeV1(expanded: Record<string, ExpandedItem>): FormatV1File {
  const texts: Descriptions[] = [];
  const index = new Map<string, number>();
  const items: FormatV1File['items'] = {};
  for (const [hash, item] of Object.entries(expanded)) {
    const { descriptions, ...keys } = item;
    delete (keys as Partial<typeof keys>).hash;
    const key = JSON.stringify(descriptions);
    let t = index.get(key);
    if (t === undefined) {
      t = texts.push(descriptions) - 1;
      index.set(key, t);
    }
    items[hash] = { ...keys, t };
  }
  return { texts, items };
}

/** Checks that every item's `t` names a stored text (the v1 output validation, spec section 3). */
export function validateV1(file: FormatV1File): void {
  for (const [hash, item] of Object.entries(file.items)) {
    if (!Number.isInteger(item.t) || item.t < 0 || item.t >= file.texts.length)
      throw new Error(`Item ${hash} points at missing text ${item.t}`);
    for (const target of (item.associated as number[] | undefined) ?? [])
      if (!Object.hasOwn(file.items, String(target)))
        throw new Error(`Item ${hash} is associated with ${target}, which is not in the file`);
  }
}
