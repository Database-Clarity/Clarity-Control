// ENHANCED-ARROW consumer proof of a write plan (read-only). Run with tsx from the repository root:
//
//   npx tsx scripts/enhanced-arrow/proof.ts --data <editor-data clone> --plan <plan.json>
//       --inputs <dir: items.json, categories.json, aliases.json> --out <file.json>
//
// Builds the exported input and every legacy file (the 7 deployed presets and clarityV2) from the
// clone's stored tooltips and from the same tooltips with the plan's after-images, through the
// real export path (exportAll.ts), and compares the bytes. Exported-input differences are listed
// per perk (the hand rows' brace holders). Then the Review changes status of every counted
// tooltip, as the web app computes it (apps/web/src/features/review/model.ts: publishableHash
// with the generator aliases against live/pushed.json; markerOnly when the alias-free digest
// matches), before and after. Exits 1 if any legacy file differs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  incomingAliases,
  isTextlessDescription,
  publishableHash,
  resolveAlias,
  tooltipSchema,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { exportAll, readInputs, readTooltipFiles } from './exportAll.js';
import type { Plan } from './plan.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    plan: { type: 'string' },
    inputs: { type: 'string' },
    out: { type: 'string' },
  },
});
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return resolve(value);
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const data = need('data');
const repo = resolve(import.meta.dirname, '../..');
const identical: number[] = JSON.parse(
  readFileSync(join(repo, 'packages/export/test/fixtures/legacy-identical.json'), 'utf8'),
).editorData;
const inputs = readInputs(need('inputs'));
const plan = JSON.parse(readFileSync(need('plan'), 'utf8')) as Plan;
const files = readTooltipFiles(data);
const after = { ...files };
for (const change of plan.changes) {
  if (files[change.path] !== change.before)
    throw new Error(`${change.path}: not the plan's before`);
  after[change.path] = change.after;
}
const parse = (all: Record<string, string>): Tooltip[] =>
  Object.values(all).map((bytes) => tooltipSchema.parse(JSON.parse(bytes)));
const storedTooltips = parse(files);
const afterTooltips = parse(after);

const A = exportAll(storedTooltips, inputs, identical);
const B = exportAll(afterTooltips, inputs, identical);
const outputs: Record<string, { stored: string; after: string; identical: boolean }> = {};
let failures = 0;
for (const name of Object.keys(A.files)) {
  const row = {
    stored: sha256(A.files[name]!),
    after: sha256(B.files[name]!),
    identical: A.files[name] === B.files[name],
  };
  if (!row.identical) failures++;
  outputs[name] = row;
}
const perksA = (JSON.parse(A.input) as { perks: Record<string, unknown> }).perks;
const perksB = (JSON.parse(B.input) as { perks: Record<string, unknown> }).perks;
const inputDiff = [...new Set([...Object.keys(perksA), ...Object.keys(perksB)])]
  .filter((key) => JSON.stringify(perksA[key]) !== JSON.stringify(perksB[key]))
  .sort();

const pushed = JSON.parse(readFileSync(join(data, 'live/pushed.json'), 'utf8')) as Record<
  string,
  string
>;
async function status(tooltip: Tooltip) {
  const digest = await publishableHash(tooltip, inputs.aliases);
  const marker = pushed[tooltip.hash];
  if (digest === marker) return 'clean';
  if (marker === undefined) return 'new';
  const bare = incomingAliases(tooltip.hash, inputs.aliases).length
    ? await publishableHash(tooltip, {})
    : digest;
  return bare === marker ? 'markerOnly' : 'pending';
}
const counted = (tooltip: Tooltip) =>
  !isTextlessDescription(tooltip) && resolveAlias(tooltip.hash, inputs.aliases) === tooltip.hash;
const afterByHash = new Map(afterTooltips.map((tooltip) => [tooltip.hash, tooltip]));
const tally = { before: {} as Record<string, number>, after: {} as Record<string, number> };
const flips: Record<string, number[]> = {};
for (const tooltip of storedTooltips.filter(counted)) {
  const before = await status(tooltip);
  const next = await status(afterByHash.get(tooltip.hash)!);
  tally.before[before] = (tally.before[before] ?? 0) + 1;
  tally.after[next] = (tally.after[next] ?? 0) + 1;
  if (before !== next) (flips[`${before} -> ${next}`] ??= []).push(tooltip.hash);
}

const result = {
  tooltips: storedTooltips.length,
  planFiles: plan.changes.length,
  outputs,
  failures,
  exportedInput: {
    stored: sha256(A.input),
    after: sha256(B.input),
    identical: A.input === B.input,
    differingPerks: inputDiff,
  },
  reviewChanges: {
    ...tally,
    flips: Object.fromEntries(Object.entries(flips).map(([key, list]) => [key, list.length])),
    flipped: flips,
  },
};
writeFileSync(need('out'), `${JSON.stringify(result, null, 1)}\n`, { flag: 'wx' });
console.log(
  JSON.stringify(
    {
      ...result,
      outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.identical])),
      reviewChanges: { ...result.reviewChanges, flipped: undefined },
    },
    null,
    1,
  ),
);
if (failures) process.exitCode = 1;
