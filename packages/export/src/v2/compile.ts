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
import { lowerConsumerMarkup } from '@clarity/core/markup/braces';
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
  configurableFormatVersion,
  exportLanguages,
  isLegacyFile,
  isPerLanguage,
  type ExportLanguage,
  type Shape,
} from './vocabulary.js';
import { emptyNotes, transform, type Line, type TransformNotes } from './transform.js';

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

export type Descriptions = Partial<Record<ExportLanguage, Line[] | string>>;
/** Known edit time (`at`, ISO) and editor (`by`, opt-in); `{ en: {} }` can mark English stand-in text. */
export type Edited = Partial<Record<ExportLanguage, { at?: string; by?: string }>>;
/** The chosen keys of one perk, in output order (spec section 7). */
export type PerkKeys = {
  name?: string;
  itemHash?: number;
  itemName?: string;
  /** The generator category id, as the config names it. */
  category?: string;
  edited?: Edited;
  /** Perks this one refers to (keyword verbs and the like) that are in the same file. */
  references?: number[];
};
/** A perk of the expanded (per-hash) form, before encoding. */
export type ExpandedItem = { hash: number } & PerkKeys & { descriptions: Descriptions };

/**
 * Format v2 file (spec section 7): a self-describing header, every distinct `descriptions` value
 * stored once, and each perk naming its one by index (`description`).
 */
export type FormatV2File = {
  format: typeof configurableFormatVersion;
  shape: Shape;
  languages: ExportLanguage[];
  descriptions: Descriptions[];
  perks: Record<string, PerkKeys & { description: number }>;
};

/** One URL's content: the whole file, or one language of a file split per language. */
export type PlanOutput = {
  languages: ExportLanguage[];
  /** The expanded form (what the reference decoder returns). */
  expanded: Record<string, ExpandedItem>;
  /** The encoded file before serialising. */
  file: FormatV2File;
  bytes: Uint8Array;
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
  /** Configurable files: one output per URL (one, or one per language). */
  outputs?: PlanOutput[];
  /** Configurable files: `outputs[0].expanded`. */
  expanded?: Record<string, ExpandedItem>;
  /** Configurable files: `outputs[0].file`. */
  file?: FormatV2File;
  /** The bytes of the file. For a configurable file, these are the first output's bytes. */
  bytes: Uint8Array;
  notices: Notice[];
};

const encoder = new TextEncoder();

/**
 * Builds one file. Throws when the input is invalid (bad aliases or associations), when a
 * tooltip in the file has a markup error the editor reports (unresolved or cyclic import,
 * malformed base/enhanced pair; the message names the hash and language).
 */
export function compile(input: LegacyInput, file: ExportFile, options: CompileOptions): Plan {
  // Element-tagged text compiles exactly as its lowered form (`<solar/>Scorch`) written by hand.
  input = lowerInput(input, undefined, !isLegacyFile(file) && file.format.elementTags);
  if (isLegacyFile(file)) {
    const bytes = buildLegacy(input, file.preset, {
      identical: options.identical,
      arrowFallback: file.arrowFallback,
    });
    return {
      stages: compileStages,
      ran: ['resolve', 'select-rows', 'references', 'serialise'],
      legacy: true,
      bytes,
      notices: [],
    };
  }
  if (file.formatVersion !== configurableFormatVersion)
    throw new Error('Unsupported configurable file format');
  return compileStyle(input, file, options);
}

/**
 * The stand-in rule of a per-language file: English stands in for a perk's text in `language`
 * when `rows` (the perk's resolved lines per language) hold nothing visible in that language, or
 * when its translation falls back to English (more than 90 days behind, `englishFallback`). Such
 * text is written under `language` and carries `edited.en` instead of `edited.<language>`.
 */
export const standsIn = (
  perk: { editor: Partial<Record<ExportLanguage, { main: string; englishFallback?: true }>> },
  language: ExportLanguage,
  rows: Partial<Record<ExportLanguage, unknown>>,
) => rows[language] === undefined || perk.editor[language]?.englishFallback === true;

/** Globals of one language, built as the editor preview builds them (tooltipImports, variants.ts). */
export function globalsOf(lookup: ExpandedPerks, language: ExportLanguage) {
  const imports: Record<string, string> = Object.create(null);
  for (const [hash, perk] of Object.entries(lookup))
    imports[hash] = perk.editor[language]?.main ?? '';
  return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
}

export function globalsForCell(
  globals: ReadonlyMap<ExportLanguage, ReturnType<typeof globalsOf>>,
  language: ExportLanguage,
  englishFallback?: true,
) {
  const lang = englishFallback ? 'en' : language;
  return { ...globals.get(language)!, imports: globals.get(lang)!.imports, lang };
}

/** The format v2 reader's source-to-lines step, also used by the in-place publish proof. */
export function readFormatV2Lines(
  text: string,
  globals: MarkupGlobals,
  hash: string,
  language: ExportLanguage,
) {
  const { lines, diagnostics } = parseMarkup(text, globals);
  const error = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (error) throw new Error(`Tooltip ${hash} (${language}): ${error.message}`);
  return lines;
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
  // One file per language: a perk without text in a language carries its English text there.
  const perLanguage = isPerLanguage(file);
  const resolving = perLanguage
    ? exportLanguages.filter((language) => language === 'en' || languages.includes(language))
    : languages;
  const globals = new Map(
    [...new Set<ExportLanguage>(['en', ...resolving])].map((language) => [
      language,
      globalsOf(lookup, language),
    ]),
  );
  const resolved = new Map<string, Partial<Record<ExportLanguage, MarkupLine[]>>>();
  const resolve = (hash: string, perk: IntermediatePerk) => {
    let rows = resolved.get(hash);
    if (rows) return rows;
    rows = {};
    for (const language of resolving) {
      const cell = perk.editor[language];
      if (cell === undefined) continue;
      const markupGlobals: MarkupGlobals = {
        ...globalsForCell(globals, language, cell.englishFallback),
        type: perk.type,
      };
      const lines = readFormatV2Lines(cell.main, markupGlobals, hash, language);
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
  const categoryOf = new Map<string, string>();
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
    // One file per language holds every perk in every language (English stands in).
    if (
      perLanguage
        ? !languages.every((language) => rows[language] ?? rows.en)
        : !languages.some((language) => rows[language])
    )
      continue;
    selected.push(hash);
    categoryOf.set(hash, category);
  }
  if (uncategorised.length)
    notices.push({ kind: 'uncategorised', hashes: uncategorised.sort((a, b) => a - b) });
  ran.push('select-rows');

  // 3 key selection: only the chosen keys, in a fixed order (`edited` is per output, below).
  const keys = new Set(data.keys);
  const picked = new Map<string, PerkKeys>();
  for (const hash of selected) {
    const perk = lookup[hash];
    const item: PerkKeys = {};
    if (keys.has('name') && perk.name) item.name = perk.name;
    if (keys.has('itemHash') && perk.itemHash !== undefined) item.itemHash = perk.itemHash;
    if (keys.has('itemName') && perk.itemName) item.itemName = perk.itemName;
    if (keys.has('category')) item.category = categoryOf.get(hash);
    if (keys.has('references') && perk.associated?.length) item.references = [...perk.associated];
    picked.set(hash, item);
  }
  /** `edited.<lang>` of a perk whose text in `language` was last edited in `source`. */
  const editedOf = (hash: string, source: ExportLanguage) => {
    const tracker = lookup[hash].updateTracker?.descriptions[source];
    if (!tracker) return undefined;
    const edit: { at?: string; by?: string } = {};
    if (keys.has('edited') && tracker.lastUpdate)
      edit.at = new Date(tracker.lastUpdate).toISOString();
    if (keys.has('editedBy') && tracker.updatedBy) edit.by = tracker.updatedBy;
    return Object.keys(edit).length ? edit : undefined;
  };
  ran.push('select-keys');

  // 4 reference policy: a referenced id whose target is not in this file is dropped. Every
  // selected row, canonical or alias, is its own item. Every
  // output holds every selected perk, so this holds for each of them.
  const inFile = new Set(selected.map(Number));
  for (const item of picked.values()) {
    if (!item.references) continue;
    const kept = item.references.filter((target) => inFile.has(target));
    if (kept.length) item.references = kept;
    else delete item.references;
  }
  ran.push('references');

  // 5 symbol transforms for the file's shape, then one expanded form per output: the whole file,
  // or one per language, where a perk without text in that language (or one whose translation is
  // behind and falls back to English) carries the English text and `edited.en`.
  const notes: TransformNotes = emptyNotes();
  const transformed = new Map<string, Line[] | string>();
  const textOf = (hash: string, language: ExportLanguage) => {
    const key = `${hash}\n${language}`;
    if (!transformed.has(key))
      transformed.set(key, transform(resolved.get(hash)![language]!, format, shape, notes));
    return transformed.get(key)!;
  };
  let showcase: Line[] | string | undefined;
  if (data.includeShowcase) {
    // Match the same element-tag opt-in as ordinary rows.
    const { lines, diagnostics } = parseMarkup(
      format.elementTags ? showcaseText : lowerConsumerMarkup(showcaseText),
      showcaseGlobals,
    );
    if (diagnostics.length) throw new Error('Invalid built-in showcase markup');
    showcase = transform(lines, format, shape, notes);
  }
  const expand = (outputLanguages: ExportLanguage[]) => {
    const expanded: Record<string, ExpandedItem> = {};
    for (const hash of selected) {
      const rows = resolved.get(hash)!;
      const descriptions: Descriptions = {};
      const edited: Edited = {};
      for (const language of outputLanguages) {
        const own = rows[language] !== undefined;
        if (!own && !perLanguage) continue;
        descriptions[language] = textOf(hash, own ? language : 'en');
        const englishStandIn =
          perLanguage && language !== 'en' && standsIn(lookup[hash], language, rows);
        const source = englishStandIn ? 'en' : language;
        const edit = editedOf(hash, source);
        if (edit) edited[source] = edit;
        else if (englishStandIn && (keys.has('edited') || keys.has('editedBy'))) edited.en = {};
      }
      const { references, ...item } = picked.get(hash)!;
      expanded[hash] = {
        hash: Number(hash),
        ...item,
        ...(Object.keys(edited).length ? { edited } : {}),
        ...(references ? { references } : {}),
        descriptions,
      };
    }
    // The showcase is an English example in each language: self-contained, never translated.
    if (showcase !== undefined)
      expanded[showcaseId] = {
        hash: Number(showcaseId),
        ...(keys.has('name') ? { name: showcaseName } : {}),
        descriptions: Object.fromEntries(outputLanguages.map((language) => [language, showcase])),
      };
    return expanded;
  };
  const expandedOutputs = (perLanguage ? languages.map((language) => [language]) : [languages]).map(
    (outputLanguages) => ({ languages: outputLanguages, expanded: expand(outputLanguages) }),
  );
  if (notes.unchosen.size)
    notices.push({ kind: 'unchosen-symbol', symbols: [...notes.unchosen].sort() });
  if (notes.retired.size)
    notices.push({ kind: 'retired-markup', classNames: [...notes.retired].sort() });
  if (notes.tables) notices.push({ kind: 'tables-dropped', count: notes.tables });
  ran.push('transform');

  // 6 encoding (section 7): header, shared descriptions, chosen keys only.
  const encoded = expandedOutputs.map((output) => ({
    ...output,
    file: encodeV2(output.expanded, { shape, languages: output.languages }),
  }));
  ran.push('encode');

  // 7 serialise: minified JSON, UTF-8, after checking every description index and relation.
  const outputs: PlanOutput[] = encoded.map((output) => {
    validateV2(output.file);
    return { ...output, bytes: encoder.encode(JSON.stringify(output.file)) };
  });
  ran.push('serialise');

  const [first] = outputs;
  return {
    stages: compileStages,
    ran,
    legacy: false,
    outputs,
    expanded: first!.expanded,
    file: first!.file,
    bytes: first!.bytes,
    notices,
  };
}

/**
 * Encodes the expanded form as format v2: the header, every distinct `descriptions` value stored
 * once (first use first), and each perk naming its one by index `description`. Perks keep their
 * keys minus `hash` (the object key) and `descriptions`.
 */
export function encodeV2(
  expanded: Record<string, ExpandedItem>,
  header: { shape: Shape; languages: ExportLanguage[] },
): FormatV2File {
  const descriptions: Descriptions[] = [];
  const index = new Map<string, number>();
  const perks: FormatV2File['perks'] = {};
  for (const [hash, item] of Object.entries(expanded)) {
    const { descriptions: own, ...keys } = item;
    delete (keys as Partial<typeof keys>).hash;
    const key = JSON.stringify(own);
    let description = index.get(key);
    if (description === undefined) {
      description = descriptions.push(own) - 1;
      index.set(key, description);
    }
    perks[hash] = { ...keys, description };
  }
  return {
    format: configurableFormatVersion,
    shape: header.shape,
    languages: [...header.languages],
    descriptions,
    perks,
  };
}

/** Checks the header, that every perk's `description` is stored, and that every referenced perk is
 * in the file (spec section 3). */
export function validateV2(file: FormatV2File): void {
  if (file.format !== configurableFormatVersion || !Array.isArray(file.descriptions) || !file.perks)
    throw new Error('Not a format v2 file');
  for (const [hash, perk] of Object.entries(file.perks)) {
    if (
      !Number.isInteger(perk.description) ||
      perk.description < 0 ||
      perk.description >= file.descriptions.length
    )
      throw new Error(`Perk ${hash} points at missing description ${perk.description}`);
    for (const target of perk.references ?? [])
      if (!Object.hasOwn(file.perks, String(target)))
        throw new Error(`Perk ${hash} refers to ${target}, which is not in the file`);
  }
}
