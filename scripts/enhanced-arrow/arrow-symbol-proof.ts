// Read-only classification of clarityV2. The seven legacy files and Review statuses
// are independently checked by proof.ts; this checks the expected structured symbol delta.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { exportLegacy, tooltipSchema } from '../../packages/core/src/index.js';
import { buildLegacy } from '../../packages/export/src/index.js';
import { readInputs, readTooltipFiles } from './exportAll.js';
import type { Plan } from './plan.js';
import { sha256 } from '../mult-write/rewrite.js';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    inputs: { type: 'string' },
    plan: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.data || !values.inputs || !values.plan || !values.out)
  throw new Error('Need --data, --inputs, --plan, and --out');
const planBytes = readFileSync(values.plan, 'utf8');
const plan = JSON.parse(planBytes) as Plan;
const files = readTooltipFiles(resolve(values.data));
const after = { ...files };
for (const change of plan.changes) {
  if (files[change.path] !== change.before) throw new Error(`Not the before-image: ${change.path}`);
  after[change.path] = change.after;
}
const inputs = readInputs(resolve(values.inputs));
const identical = JSON.parse(
  readFileSync(resolve('packages/export/test/fixtures/legacy-identical.json'), 'utf8'),
).editorData as number[];
const build = (all: Record<string, string>) => {
  const tooltips = Object.values(all).map((bytes) => tooltipSchema.parse(JSON.parse(bytes)));
  const perks = exportLegacy(
    tooltips,
    Date.parse('2026-11-14T00:00:00Z'),
    inputs.facts,
    inputs.aliases,
  );
  return Buffer.from(
    buildLegacy(JSON.parse(JSON.stringify({ perks })), 'clarityV2', { identical }),
  ).toString('utf8');
};
const beforeBytes = build(files);
const afterBytes = build(after);
// Lower arrow symbol nodes, preserving their surrounding styles, then coalesce
// adjacent text nodes of the same shape (symbol insertion splits those nodes).
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const raw of value) {
      const next = normalize(raw);
      const previous = out.at(-1);
      if (
        previous &&
        next &&
        typeof previous === 'object' &&
        typeof next === 'object' &&
        'text' in previous &&
        'text' in next &&
        typeof previous.text === 'string' &&
        typeof next.text === 'string'
      ) {
        const { text: left, ...a } = previous;
        const { text: right, ...b } = next;
        if (isDeepStrictEqual(a, b)) {
          previous.text = left + right;
          continue;
        }
      }
      out.push(next);
    }
    return out;
  }
  if (!value || typeof value !== 'object') return value;
  const node = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
  );
  if (Array.isArray(node.classNames) && node.classNames.includes('arrow')) {
    if (Object.hasOwn(node, 'text')) throw new Error('Arrow node unexpectedly has text');
    node.classNames = node.classNames.filter((name) => name !== 'arrow');
    if (!node.classNames.length) delete node.classNames;
    node.text = '🠚';
  }
  return node;
}
const before = JSON.parse(beforeBytes) as Record<string, unknown>;
const next = JSON.parse(afterBytes) as Record<string, unknown>;
const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])]
  .filter((key) => !isDeepStrictEqual(before[key], next[key]))
  .sort();
const expected = plan.changes.map(({ hash }) => String(hash)).sort();
const unexpected = changed.filter(
  (hash) => !isDeepStrictEqual(normalize(before[hash]), normalize(next[hash])),
);
const result = {
  planSha256: sha256(planBytes),
  beforeSha256: sha256(beforeBytes),
  afterSha256: sha256(afterBytes),
  changed,
  expected,
  unexpected,
  exactTooltipSet: isDeepStrictEqual(changed, expected),
  arrowFormOnly: unexpected.length === 0,
};
writeFileSync(join(resolve(values.out), 'clarityV2-before.json'), beforeBytes, { flag: 'wx' });
writeFileSync(join(resolve(values.out), 'clarityV2-after.json'), afterBytes, { flag: 'wx' });
writeFileSync(
  join(resolve(values.out), 'classification.json'),
  `${JSON.stringify(result, null, 1)}\n`,
  { flag: 'wx' },
);
console.log(JSON.stringify(result, null, 1));
// Source/output set equality is informational: imported enhanced variants can emit
// under another hash. arrow-symbol-attribution.ts gates their actual dependency reads.
if (!result.arrowFormOnly) process.exitCode = 1;
