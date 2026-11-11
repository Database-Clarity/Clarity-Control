import { converterSettings, expandAliases, type IntermediatePerks } from './converter/index.js';
import { customJsonStringify } from './converter/helpers.js';
import { databaseConverter } from './converter/publisher.js';

/** The eight held presets, in the order the held converter builds them. */
export const legacyPresets = [
  'clarity',
  'dim',
  'crayon',
  'foundry',
  'lightGG',
  'braytech',
  'vaultZero',
  'clarityV2',
] as const;
export type LegacyPreset = (typeof legacyPresets)[number];

/** The seven presets that have a file at the old URLs today (clarityV2 has none). */
export const deployedLegacyPresets: readonly LegacyPreset[] = legacyPresets.filter(
  (preset) => preset !== 'clarityV2',
);

/** The published input: `liveDescriptions.json` (`perks`, plus `databaseSettings`, which is not used). */
export type LegacyInput = { perks: IntermediatePerks; databaseSettings?: unknown };

/** Bungie's manifest items, only the description is read (`DestinyInventoryItemDefinition`). */
export type InventoryItems = Record<
  string,
  { displayProperties?: { description?: string } } | undefined
>;

export type LegacyOptions = {
  /**
   * Hashes whose English text equals Bungie's own description (see `bungieIdentical`). Presets that
   * leave such entries out (all but crayon and vaultZero) skip them. Empty when not given.
   */
  identical?: Iterable<string | number>;
};

/** The file name of a preset at the old URLs, with its exact case (`lightGG.json`, `vaultZero.json`). */
export const legacyFileName = (preset: LegacyPreset) => `${preset}.json`;

const encoder = new TextEncoder();

const isLegacyPreset = (preset: string): preset is LegacyPreset =>
  (legacyPresets as readonly string[]).includes(preset) && Object.hasOwn(converterSettings, preset);

/**
 * The hashes whose English text (after trimming) equals Bungie's description for that hash, the
 * same test the held publisher made against the manifest. An alias is tested with the text of the
 * tooltip it points at and its own hash's Bungie description.
 */
export function bungieIdentical(input: LegacyInput, inventoryItem: InventoryItems): string[] {
  const lookup = expandAliases(input.perks);
  const hashes: string[] = [];
  for (const hash of Object.keys(input.perks)) {
    const perk = lookup[hash];
    if (perk === undefined) continue;
    const english = perk.editor.en?.main.trim() || '';
    if (english === inventoryItem[hash]?.displayProperties?.description) hashes.push(hash);
  }
  return hashes;
}

/**
 * Builds one legacy file and returns its bytes (UTF-8), exactly as the held converter wrote it.
 * Throws if the preset is unknown or the input is invalid for it (bad references, missing imports).
 */
export function buildLegacy(
  input: LegacyInput,
  preset: LegacyPreset,
  options: LegacyOptions = {},
): Uint8Array {
  if (!isLegacyPreset(preset)) throw new Error(`Unknown legacy preset: ${String(preset)}`);
  const identical = new Set([...(options.identical ?? [])].map(String));
  const output = databaseConverter(preset, input.perks, identical);
  const text = customJsonStringify(output, ['stat', 'multiplier', 'weaponTypes', 'classNames']);
  return encoder.encode(text);
}

/** `versions.json` contents: any other keys are kept as they are. */
export type LegacyVersions = { descriptions: number; [key: string]: unknown };

/** The next `versions.json`: `descriptions` + 0.0001, written as the held publisher wrote it. */
export function nextVersions(previous: LegacyVersions): {
  value: LegacyVersions;
  bytes: Uint8Array;
} {
  if (typeof previous?.descriptions !== 'number' || !Number.isFinite(previous.descriptions)) {
    throw new Error('versions.json needs a numeric "descriptions" value');
  }
  const value = {
    ...previous,
    descriptions: Number((previous.descriptions * 10000 + 1).toFixed(4)) / 10000,
  };
  return { value, bytes: encoder.encode(JSON.stringify(value, null, 1)) };
}

export type LegacyFileResult =
  | { preset: LegacyPreset; name: string; ok: true; bytes: Uint8Array }
  | { preset: LegacyPreset; name: string; ok: false; error: Error };

export type LegacyBuild = {
  files: LegacyFileResult[];
  versions: { name: 'versions.json'; value: LegacyVersions; bytes: Uint8Array };
};

/**
 * Builds every legacy file on its own: one preset failing never stops the others. Its result has
 * `ok: false` and the error, and the caller keeps (carries forward) the old file. `versions.json`
 * is always bumped by 0.0001 from `previousVersions`, whatever the files' outcomes.
 */
export function buildAllLegacy(
  input: LegacyInput,
  previousVersions: LegacyVersions,
  options: LegacyOptions & { presets?: readonly LegacyPreset[] } = {},
): LegacyBuild {
  const versions = nextVersions(previousVersions);
  const identical = [...(options.identical ?? [])];
  const files = (options.presets ?? deployedLegacyPresets).map((preset): LegacyFileResult => {
    const name = legacyFileName(preset);
    try {
      return { preset, name, ok: true, bytes: buildLegacy(input, preset, { identical }) };
    } catch (error) {
      return {
        preset,
        name,
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
  return { files, versions: { name: 'versions.json', ...versions } };
}
