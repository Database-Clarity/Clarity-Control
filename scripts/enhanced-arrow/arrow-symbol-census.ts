// Read-only: tsx ... --data <pristine clone> --out <new evidence directory>.
// Compatible with enhanced-arrow/proof.ts. No data write, commit, or push.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from '../mult-write/rewrite.js';
import { readTooltipFiles } from './exportAll.js';
import { planBytes, summary } from './plan.js';
import { planTypedArrows } from './arrow-symbol-plan.js';

const { values } = parseArgs({ options: { data: { type: 'string' }, out: { type: 'string' } } });
if (!values.data || !values.out) throw new Error('Need --data and --out');
const { plan, refused } = planTypedArrows(readTooltipFiles(resolve(values.data)));
const bytes = planBytes(plan);
const report = { planSha256: sha256(bytes), ...summary(plan), refused };
mkdirSync(resolve(values.out), { recursive: true });
writeFileSync(join(values.out, 'plan.json'), bytes, { flag: 'wx' });
writeFileSync(join(values.out, 'census.json'), `${JSON.stringify(report, null, 1)}\n`, {
  flag: 'wx',
});
console.log(JSON.stringify(report, null, 1));
