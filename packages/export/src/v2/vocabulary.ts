// The v2 vocabulary: names, limits, and ids shared by the config schema (config.ts, zod) and the
// engine. Kept free of zod so the engine bundle the preview loads stays small.
import { legacyPresets } from '../legacy.js';
import type { ExportFile, LegacyFile, StyleFile } from './config.js';

/** Current config schema version (the config JSON's own shape). */
export const configSchemaVersion = 1;
/** Output contracts this engine can build (spec section 5, "Format version"). */
export const configurableFormatVersion = 2;
export const supportedFormatVersions = [1, configurableFormatVersion] as const;

/** Maps a saved configurable format number to the current one. */
export const currentFileFormatVersion = (preset: unknown, version: number): number =>
  version === 1 && styles.some((style) => style === preset) ? configurableFormatVersion : version;

/** The four styles a new file starts from (presets in styles.ts). */
export const styles = ['structured', 'markdown', 'discord', 'plain'] as const;
export type Style = (typeof styles)[number];

export const shapes = ['lines', 'text'] as const;
export type Shape = (typeof shapes)[number];

export const exportLanguages = [
  'en',
  'de',
  'fr',
  'it',
  'pl',
  'ru',
  'es',
  'es-mx',
  'ko',
  'pt-br',
  'ja',
  'zh-cht',
  'zh-chs',
] as const;
export type ExportLanguage = (typeof exportLanguages)[number];

/**
 * Per-perk keys a file can include (spec section 7). `edited` writes `edited.<lang>.at` (ISO time
 * of the last edit); `editedBy` writes `edited.<lang>.by` (the editor's name), with or without
 * `edited`. `references` lists perks this one refers to. Default: `name` and `edited` (styles.ts
 * defaultData).
 */
export const itemKeys = [
  'name',
  'itemHash',
  'itemName',
  'category',
  'edited',
  'editedBy',
  'references',
] as const;
export type ItemKey = (typeof itemKeys)[number];

/** One file holding every chosen language, or one file per language (spec section 7). */
export const languageFilesModes = ['combined', 'perLanguage'] as const;
export type LanguageFiles = (typeof languageFilesModes)[number];

/** The 16 icons of the v2 markup (core syntax.ts markupIcons), in the editor's order. */
export const iconSymbols = [
  'kinetic',
  'arc',
  'solar',
  'stasis',
  'void',
  'strand',
  'prismatic',
  'heavy',
  'primary',
  'special',
  'barrier',
  'overload',
  'unstoppable',
  'hunter',
  'titan',
  'warlock',
] as const;
/** Format v2 symbols (spec section 6): 16 icons, the enhanced arrow, and the text styles. */
export const symbolIds = [
  ...iconSymbols,
  'arrow',
  'enhancedArrow',
  'bold',
  'exotic',
  'pve',
  'pvp',
  'elementText',
] as const;
export type SymbolId = (typeof symbolIds)[number];

/** Limits (spec sections 3, 4, and 6). */
export const configLimits = {
  files: 3,
  /** Active files plus retained entries (spec section 3, "Workload bounds"). */
  urlSlots: 6,
  retainedPerFile: 2,
  string: 64,
  categories: 64,
} as const;

export const idPattern = /^[a-z][a-z0-9-]{1,31}$/;
const reservedIds = new Set([
  '_build',
  'changelog',
  'index',
  'api',
  'assets',
  'well-known',
  'reference',
]);
/** Project and file ids: path-safe and not a reserved name (spec section 4). */
export const isValidId = (id: string) =>
  idPattern.test(id) && !reservedIds.has(id) && !/^v\d+$/.test(id);

/** A legacy preset file: frozen, built by the held converter path. */
export const isLegacyFile = (file: ExportFile): file is LegacyFile =>
  (legacyPresets as readonly string[]).includes(file.preset);

/** A style file split into one URL per language. */
export const isPerLanguage = (file: ExportFile) =>
  !isLegacyFile(file) && file.data.languageFiles === 'perLanguage';

type FileRef = Pick<ExportFile, 'id' | 'formatVersion'> & Partial<Pick<StyleFile, 'data'>>;

/**
 * A file's URL key, relative to the site root: `<project>/v<format>/<file>.json`, or for one file
 * per language the folder `<project>/v<format>/<file>` that holds `<lang>.json`. Slot limits
 * count active files and retained entries. Actual URLs from `fileUrls` are unique; a shared
 * language folder still belongs to one uid.
 */
export const filePath = (projectId: string, file: FileRef) =>
  `${projectId}/v${file.formatVersion}/${file.id}${file.data?.languageFiles === 'perLanguage' ? '' : '.json'}`;

/** Every URL of a file, with the languages each holds (legacy files hold every language). */
export function fileUrls(
  projectId: string,
  file: ExportFile,
): { path: string; languages: ExportLanguage[] }[] {
  const key = filePath(projectId, file);
  if (isLegacyFile(file)) return [{ path: key, languages: [...exportLanguages] }];
  const languages = exportLanguages.filter((language) => file.data.languages.includes(language));
  return isPerLanguage(file)
    ? languages.map((language) => ({ path: `${key}/${language}.json`, languages: [language] }))
    : [{ path: key, languages }];
}
