// ENHANCED-ARROW census and dry run (read-only: nothing is written to the data). Run with tsx
// from the repository root on a clone of the editor-data branch:
//
//   npx tsx scripts/enhanced-arrow/cli.ts --data <editor-data> --inputs <dir> --out <dir>
//       [--baseline <hashes.json from scripts/enhanced-arrow/hashes.ts on a v2 tree>]
//
// `--inputs` holds the generator's items.json, categories.json, and aliases.json. Writes to
// `--out` (which must not exist): census.json (arrows per language and category, skipped uses,
// merge candidates), plan.json (every text the rewrite would change: hash, language, the stored
// and rewritten text, the changed lines; only `text` changes, no metadata, because a markup-only
// edit keeps updatedAt and updatedBy), and parity.json: every legacy file and the exported input
// built from the stored data and from the rewritten data, with their sha256 and byte equality
// (and, with --baseline, equality with the same files built by another tree). Exits 1 unless
// every pair is byte-identical.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { tooltipSchema, type Tooltip } from '../../packages/core/src/index.js';
import { exportAll, readInputs, readTooltipFiles } from './exportAll.js';
import { census, rewriteLegacyArrow, type CensusText } from './rewrite.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    inputs: { type: 'string' },
    out: { type: 'string' },
    baseline: { type: 'string' },
  },
});
const need = (name: 'data' | 'inputs' | 'out') => {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return resolve(value);
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const out = need('out');
if (existsSync(out)) throw new Error(`${out} exists`);

const repo = resolve(import.meta.dirname, '../..');
const identical: number[] = JSON.parse(
  readFileSync(join(repo, 'packages/export/test/fixtures/legacy-identical.json'), 'utf8'),
).editorData;
const inputs = readInputs(need('inputs'));
const files = readTooltipFiles(need('data'));
const stored: Tooltip[] = Object.values(files).map((bytes) => tooltipSchema.parse(JSON.parse(bytes)));
const byHash = new Map(stored.map((tooltip) => [tooltip.hash, tooltip]));

const texts: CensusText[] = [];
for (const tooltip of stored) {
  const category =
    tooltip.custom?.categoryId ?? (inputs.items[tooltip.hash]?.categoryId as string) ?? 'none';
  for (const [lang, entry] of Object.entries(tooltip.text)) {
    if (!entry) continue;
    const globals = byHash.get(2)?.text;
    texts.push({
      hash: tooltip.hash,
      lang,
      category,
      text: entry.text,
      globals: (globals?.[lang as keyof typeof globals] ?? globals?.en)?.text ?? '',
    });
  }
}
const found = census(texts);

// The dry run: the rewritten tooltips, in memory only.
const plan: { hash: number; lang: string; lines: number[]; before: string; after: string }[] = [];
const rewritten: Tooltip[] = stored.map((tooltip) => {
  const next = structuredClone(tooltip);
  for (const [lang, entry] of Object.entries(next.text)) {
    if (!entry) continue;
    const result = rewriteLegacyArrow(entry.text);
    if (result.text === entry.text) continue;
    const before = entry.text.split('\n');
    const after = result.text.split('\n');
    plan.push({
      hash: tooltip.hash,
      lang,
      lines: before.flatMap((line, index) => (line === after[index] ? [] : [index + 1])),
      before: entry.text,
      after: result.text,
    });
    entry.text = result.text;
  }
  return next;
});

const A = exportAll(stored, inputs, identical);
const B = exportAll(rewritten, inputs, identical);
const baseline = values.baseline
  ? (JSON.parse(readFileSync(resolve(values.baseline), 'utf8')) as Record<string, string>)
  : undefined;
const parity: Record<string, unknown> = {};
let failures = 0;
for (const [name, a, b] of [
  ['input', A.input, B.input],
  ...Object.keys(A.files).map((preset) => [preset, A.files[preset]!, B.files[preset]!]),
] as [string, string, string][]) {
  const row = {
    storedSha256: sha256(a),
    rewrittenSha256: sha256(b),
    rewrittenIdentical: a === b,
    ...(baseline && { baselineSha256: baseline[name], baselineIdentical: baseline[name] === sha256(a) }),
  };
  if (!row.rewrittenIdentical || (baseline && !row.baselineIdentical)) failures++;
  parity[name] = row;
}

mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 1)}\n`);
write('census.json', found);
write('plan.json', plan);
write('parity.json', { tooltips: stored.length, rewrittenTexts: plan.length, failures, parity });
console.log(
  JSON.stringify(
    {
      tooltips: stored.length,
      arrows: found.arrows,
      skipped: found.skipped.length,
      longerNames: found.longerNames,
      merged: found.merged.length,
      localArrowDefinitions: found.localArrowDefinitions.length,
      rewrittenTexts: plan.length,
      rewrittenUses: plan.reduce((sum, row) => sum + (row.after.match(/<enhanced\/>/g)?.length ?? 0), 0),
      failures,
    },
    null,
    1,
  ),
);
if (failures) process.exitCode = 1;
