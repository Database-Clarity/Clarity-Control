// Shared by set-bonus.test.ts and the set-bonus-real-<n>.test.ts parts. The real-data check
// builds every deployed legacy file twice from the full editor export (about 200 s on CI in one
// test), so it is split by preset into separate files that Vitest can run on separate workers
// and CI shards.
import { expect, test } from 'vitest';
import {
  buildLegacy,
  deployedLegacyPresets,
  type LegacyInput,
  type LegacyPreset,
} from '../src/index.js';
import { customJsonStringify } from '../src/converter/helpers.js';
import { editorDataInput, expected, sha256 } from './helpers.js';

export const decoder = new TextDecoder();
export const parse = (bytes: Uint8Array) =>
  JSON.parse(decoder.decode(bytes)) as Record<string, Record<string, unknown>>;
export const stringify = (value: unknown) =>
  customJsonStringify(value, ['stat', 'multiplier', 'weaponTypes', 'classNames']);

export const withType: LegacyPreset[] = [
  'clarity',
  'crayon',
  'foundry',
  'braytech',
  'vaultZero',
  'clarityV2',
];

/** How many set-bonus-real-<n>.test.ts files share the deployed presets. */
export const REAL_PARTS = 4;

let realData: { real: ReturnType<typeof editorDataInput>; added: LegacyInput } | undefined;

/** The editor data, loaded once per file, with one set bonus added. */
function realInputs() {
  if (realData) return realData;
  // Editor-data 52007db has no set bonus yet; add one as core exportLegacy writes it, with the
  // generator's facts for sandbox perk 17188252 (Atheon's Memory 2 pc).
  const real = editorDataInput();
  const english = 'Fixture set-bonus text, not Bungie text.';
  const added: LegacyInput = {
    ...real.input,
    perks: {
      ...real.input.perks,
      17188252: {
        hash: 17188252,
        name: "Atheon's Memory (2 pc): Radiolaria Breach",
        type: 'armor-set-bonus',
        editor: { en: { main: english, secondary: english } },
        uploadedBy: 'fixture',
        lastUpload: 1700000000000,
        inLiveDatabase: false,
        uploadToLive: false,
        updateTracker: {
          descriptions: { en: { lastUpdate: 1700000000000, updatedBy: 'fixture' } },
        },
      } as never,
    },
  };
  realData = { real, added };
  return realData;
}

/** Part `part` (0-based) of the real-data check: every REAL_PARTS-th deployed preset. */
export function realSetBonusTests(part: number) {
  const presets = deployedLegacyPresets.filter((_, index) => index % REAL_PARTS === part);
  test.each(presets)(
    'real data: one set bonus adds exactly its entry to the %s file',
    (preset) => {
      const { real, added } = realInputs();
      const before = buildLegacy(real.input, preset, { identical: real.identical });
      expect(sha256(before)).toBe(expected.editorData.files[preset]);
      const after = parse(buildLegacy(added, preset, { identical: real.identical }));
      const { 17188252: entry, ...rest } = after;
      expect(entry.hash).toBe(17188252);
      expect(entry.name).toBe("Atheon's Memory (2 pc): Radiolaria Breach");
      if (withType.includes(preset)) expect(entry.type).toBe('Armor Set Bonus');
      else expect(entry).not.toHaveProperty('type');
      // Every other entry, in order, is byte for byte the file without the set bonus.
      expect(stringify(rest)).toBe(decoder.decode(before));
    },
    300_000,
  );
}
