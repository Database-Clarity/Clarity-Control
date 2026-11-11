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

// Configurable exports: config schema 1, the compiler, and format v1 (README.md, "Format v1").
export * from './v1/vocabulary.js';
export type {
  ExportConfig,
  ExportFile,
  FileData,
  FileFormat,
  LegacyFile,
  Migration,
  StyleFile,
  SymbolRule,
} from './v1/config.js';
export {
  compile,
  compileStages,
  encodeV1,
  validateV1,
  type Catalog,
  type CompileOptions,
  type CompileStage,
  type Descriptions,
  type ExpandedItem,
  type FormatV1File,
  type Notice,
  type Plan,
} from './v1/compile.js';
export { defaultData, newStyleFile, styleFormats, styleShapes } from './v1/styles.js';
export type { OutLine, OutSpan } from './v1/transform.js';
export {
  filePath,
  projectIndex,
  type FileNotice,
  type FileOutcome,
  type IndexFile,
  type ProjectIndex,
} from './v1/project.js';
export { decodeV1 } from '../decoder/decode-v1.mjs';

// Vocabulary check (spec section 5): marker sets of an output file.
export { markerChange, markerSet, outputTokens, type MarkerChange } from './v1/markers.js';
