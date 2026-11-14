// The sha256 of every legacy file and of the exported input built from an editor-data checkout,
// by the tree this file sits in (copy it with exportAll.ts into a v2 export to get the baseline
// that cli.ts --baseline compares with):
//
//   npx tsx scripts/enhanced-arrow/hashes.ts --data <editor-data> --inputs <dir> --out <file>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { tooltipSchema } from '../../packages/core/src/index.js';
import { exportAll, readInputs, readTooltipFiles } from './exportAll.js';

const { values } = parseArgs({
  options: { data: { type: 'string' }, inputs: { type: 'string' }, out: { type: 'string' } },
});
if (!values.data || !values.inputs || !values.out) throw new Error('Need --data, --inputs, --out');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const repo = resolve(import.meta.dirname, '../..');
const identical: number[] = JSON.parse(
  readFileSync(join(repo, 'packages/export/test/fixtures/legacy-identical.json'), 'utf8'),
).editorData;
const tooltips = Object.values(readTooltipFiles(resolve(values.data))).map((bytes) =>
  tooltipSchema.parse(JSON.parse(bytes)),
);
const { input, files } = exportAll(tooltips, readInputs(resolve(values.inputs)), identical);
const hashes: Record<string, string> = { input: sha256(input) };
for (const [preset, bytes] of Object.entries(files)) hashes[preset] = sha256(bytes);
writeFileSync(resolve(values.out), `${JSON.stringify(hashes, null, 1)}\n`);
console.log(JSON.stringify(hashes, null, 1));
