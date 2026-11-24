// Engine API of the export package. README.md explains each function.
export {
  buildAllLegacy,
  buildLegacy,
  bungieIdentical,
  deployedLegacyPresets,
  legacyFileName,
  legacyPresets,
  nextVersions,
  type InventoryItems,
  type LegacyBuild,
  type LegacyFileResult,
  type LegacyInput,
  type LegacyOptions,
  type LegacyPreset,
  type LegacyVersions,
  type SandboxPerks,
} from './legacy.js';

// Configurable exports: config schema 1, the compiler, and format v2 (README.md, "Format v2").
export * from './v2/vocabulary.js';
export type {
  ExportConfig,
  ExportFile,
  FileData,
  FileFormat,
  LegacyFile,
  Migration,
  StyleFile,
  SymbolRule,
} from './v2/config.js';
export {
  compile,
  compileStages,
  encodeV2,
  validateV2,
  type Catalog,
  type CompileOptions,
  type CompileStage,
  type Descriptions,
  type Edited,
  type ExpandedItem,
  type FormatV2File,
  type Notice,
  type PerkKeys,
  type Plan,
  type PlanOutput,
} from './v2/compile.js';
export { defaultData, newStyleFile, styleFormats, styleShapes } from './v2/styles.js';
export type { Line, OutLine, OutSpan, Part } from './v2/transform.js';
export {
  fileStatus,
  projectIndex,
  type BuiltUrl,
  type FileNotice,
  type FileOutcome,
  type FileStatus,
  type IndexFile,
  type ProjectIndex,
} from './v2/project.js';
// Older web builds call the pinned engine's decoder by its former name.
export { decodeV2, decodeV2 as decodeV1 } from '../decoder/decode-v2.mjs';
// For the Exports page: the built-in feature showcase's markup source (`data.includeShowcase`)
// and the per-language stand-in rule compile uses.
export { showcaseText } from '@clarity/core/markup/showcase';
export { standsIn } from './v2/compile.js';

// Vocabulary check (spec section 5): marker sets of an output file.
export { markerChange, markerSet, outputTokens, type MarkerChange } from './v2/markers.js';
export { provesInPlace, type InPlaceRefusal } from './provesInPlace.js';
