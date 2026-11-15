// Every legacy file (the 7 deployed presets and clarityV2) from a set of stored tooltips, built
// through the real export path: core exportLegacy -> @clarity/export buildLegacy, with the
// generator's facts and aliases, as the Worker's push-live and the legacy job do (same method
// as scripts/mult-write/parity.ts). Uses only APIs that v2 already had, so the same file runs in
// a v2 baseline export to compare the bytes of both trees.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  aliasesSchema,
  exportLegacy,
  tooltipSchema,
  type LegacyCatalog,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { buildLegacy, legacyPresets, type LegacyInput } from '../../packages/export/src/index.js';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** `tooltips/<hash>.json` bytes of an editor-data checkout. */
export function readTooltipFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(dir, 'tooltips')).sort())
    if (name.endsWith('.json'))
      files[`tooltips/${name}`] = readFileSync(join(dir, 'tooltips', name), 'utf8');
  return files;
}

/** The generator's facts and aliases (`items.json`, `categories.json`, `aliases.json`). */
export function readInputs(dir: string) {
  const items = json(join(dir, 'items.json')) as Record<string, Record<string, unknown>>;
  const categories = json(join(dir, 'categories.json')) as { id: string; legacyType?: string }[];
  const aliases = aliasesSchema.parse(json(join(dir, 'aliases.json')));
  // Same facts as the Worker's catalog() (apps/worker/src/catalog.ts).
  const facts: LegacyCatalog = {};
  for (const [hash, item] of Object.entries(items)) {
    const category = categories.find(({ id }) => id === item.categoryId);
    if (!category || Number(hash) !== item.hash) throw new Error(`Bad generator item ${hash}`);
    facts[hash] = {
      name: item.name as string,
      type: category.legacyType ?? category.id,
      ...(item.itemHash === undefined ? {} : { itemHash: item.itemHash as number }),
      ...(item.itemName === undefined ? {} : { itemName: item.itemName as string }),
    };
  }
  return { items, facts, aliases };
}

const now = Date.parse('2026-11-14T00:00:00Z');

/** The exported input bytes and every legacy file's bytes. */
export function exportAll(
  tooltips: readonly Tooltip[],
  inputs: ReturnType<typeof readInputs>,
  identical: readonly number[],
): { input: string; files: Record<string, string> } {
  const perks = exportLegacy(
    tooltips.map((tooltip) => tooltipSchema.parse(tooltip)),
    now,
    inputs.facts,
    inputs.aliases,
  );
  const input = JSON.stringify({ perks });
  // The converter reads the serialized file, as the legacy job does.
  const parsed = JSON.parse(input) as LegacyInput;
  const files: Record<string, string> = {};
  for (const preset of legacyPresets)
    files[preset] = Buffer.from(buildLegacy(parsed, preset, { identical })).toString('utf8');
  return { input, files };
}
