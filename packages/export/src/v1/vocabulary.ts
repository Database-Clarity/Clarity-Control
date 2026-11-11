// The v1 vocabulary: names, limits, and ids shared by the config schema (config.ts, zod) and the
// engine. Kept free of zod so the engine bundle the preview loads stays small.
import { legacyPresets } from '../legacy.js';
import type { ExportFile, LegacyFile } from './config.js';

/** Current config schema version (the config JSON's own shape). */
export const configSchemaVersion = 1;
/** Output contracts this engine can build (spec section 5, "Format version"). */
export const supportedFormatVersions = [1] as const;

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

/** Per-item keys a file can include. `name` is the only default (spec section 7). */
export const itemKeys = [
  'name',
  'itemHash',
  'itemName',
  'type',
  'lastUpload',
  'uploadedBy',
  'updateTracker',
  'associated',
] as const;
export type ItemKey = (typeof itemKeys)[number];

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
/** Symbols v1 (spec section 6): 16 icons, the enhanced arrow, and the text styles. */
export const symbolIds = [
  ...iconSymbols,
  'enhancedArrow',
  'bold',
  'yellow',
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
const reservedIds = new Set(['_build', 'changelog', 'index', 'api', 'assets', 'well-known']);
/** Project and file ids: path-safe and not a reserved name (spec section 4). */
export const isValidId = (id: string) =>
  idPattern.test(id) && !reservedIds.has(id) && !/^v\d+$/.test(id);

/** A legacy preset file: frozen, built by the held converter path. */
export const isLegacyFile = (file: ExportFile): file is LegacyFile =>
  (legacyPresets as readonly string[]).includes(file.preset);
