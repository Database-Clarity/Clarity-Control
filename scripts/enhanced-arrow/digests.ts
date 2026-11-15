// Every tooltip's publishableHash (with the generator aliases, and alias-free) from an editor-data
// checkout, by the tree this file sits in. Run it in a v2 export and on a candidate tree to show
// that a change to publishableHash keeps every digest (read-only):
//
//   npx tsx scripts/enhanced-arrow/digests.ts --data <editor-data> --inputs <dir> --out <file>
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { publishableHash, tooltipSchema } from '../../packages/core/src/index.js';
import { readInputs, readTooltipFiles } from './exportAll.js';

const { values } = parseArgs({
  options: { data: { type: 'string' }, inputs: { type: 'string' }, out: { type: 'string' } },
});
if (!values.data || !values.inputs || !values.out) throw new Error('Need --data, --inputs, --out');
const { aliases } = readInputs(resolve(values.inputs));
const pushed = JSON.parse(
  readFileSync(join(resolve(values.data), 'live/pushed.json'), 'utf8'),
) as Record<string, string>;
const digests: Record<string, { aliases: string; bare: string }> = {};
let markersMatched = 0;
for (const bytes of Object.values(readTooltipFiles(resolve(values.data)))) {
  const tooltip = tooltipSchema.parse(JSON.parse(bytes));
  const row = {
    aliases: await publishableHash(tooltip, aliases),
    bare: await publishableHash(tooltip),
  };
  digests[tooltip.hash] = row;
  if (pushed[tooltip.hash] === row.aliases || pushed[tooltip.hash] === row.bare) markersMatched++;
}
writeFileSync(resolve(values.out), `${JSON.stringify(digests, null, 1)}\n`, { flag: 'wx' });
console.log(
  JSON.stringify({
    tooltips: Object.keys(digests).length,
    markers: Object.keys(pushed).length,
    markersMatched,
  }),
);
