// MULT-WRITE consumer-output proof. Builds every legacy file (the 7 deployed presets and
// clarityV2) through the current export path, core exportLegacy -> @clarity/export buildLegacy,
// from the whole editor data before and after the rewrite, and diffs them:
//
//   tsx scripts/mult-write/parity.ts --before <editor-data dir> (--after <dir> | --plan <plan.json>)
//       --inputs <dir: items.json, categories.json, aliases.json> --rows <proposal.json> --out <dir>
//
// The before arm uses the same method as the export package's parity input (ii) (all stored
// tooltips, generator facts, aliases, compact JSON), and its bytes are reported next to that
// fixture's pinned sha256. Bungie-identical hashes come from the export package's pinned list.
// For every preset: unchanged keys must be byte-identical, and every changed value must differ
// only in strings, each of which equals its before string with the rows' line edits applied.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  aliasesSchema,
  exportLegacy,
  tooltipSchema,
  type LegacyCatalog,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { customJsonStringify } from '../../packages/export/src/converter/helpers.js';
import { buildLegacy, legacyPresets, type LegacyInput } from '../../packages/export/src/index.js';
import { sha256, type Plan, type Row } from './rewrite.js';

const { values } = parseArgs({
  options: {
    before: { type: 'string' },
    after: { type: 'string' },
    plan: { type: 'string' },
    inputs: { type: 'string' },
    rows: { type: 'string' },
    out: { type: 'string' },
  },
});
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
// buildLegacy's own layout arguments (packages/export/src/legacy.ts).
const layoutProperties = ['stat', 'multiplier', 'weaponTypes', 'classNames'];
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const repo = resolve(import.meta.dirname, '../..');
const fixtures = join(repo, 'packages/export/test/fixtures');
const identical: number[] = json(join(fixtures, 'legacy-identical.json')).editorData;
const pinned = json(join(fixtures, 'legacy-sha256.json')).editorData as {
  inputSha256: string;
  files: Record<string, string>;
};

const inputs = need('inputs');
const items = json(join(inputs, 'items.json')) as Record<string, Record<string, unknown>>;
const categories = json(join(inputs, 'categories.json')) as { id: string; legacyType?: string }[];
const aliases = aliasesSchema.parse(json(join(inputs, 'aliases.json')));
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

const readTooltips = (dir: string) => {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(dir, 'tooltips'))) {
    if (name.endsWith('.json'))
      files[`tooltips/${name}`] = readFileSync(join(dir, 'tooltips', name), 'utf8');
  }
  return files;
};
const beforeFiles = readTooltips(need('before'));
const plan = json(need('plan')) as Plan;
// --after: a written clone, which must equal the plan's after-images and nothing else.
let afterFiles: Record<string, string> = { ...beforeFiles };
for (const change of plan.changes) {
  if (beforeFiles[change.path] !== change.before) throw new Error(`Before differs: ${change.path}`);
  afterFiles[change.path] = change.after;
}
if (values.after) {
  const written = readTooltips(values.after);
  const paths = new Set([...Object.keys(written), ...Object.keys(afterFiles)]);
  for (const path of paths) {
    if (written[path] !== afterFiles[path])
      throw new Error(`--after differs from the plan: ${path}`);
  }
  afterFiles = written;
}
// The save metadata a normal English save stamps, exported as updateTracker.descriptions.en.
const metadata = new Map(
  plan.changes.map((change) => {
    const [before, after] = [change.before, change.after].map(
      (bytes) => tooltipSchema.parse(JSON.parse(bytes)).text.en!,
    );
    return [
      String(change.hash),
      {
        lastUpdate: [Date.parse(before!.updatedAt), Date.parse(after!.updatedAt)],
        updatedBy: [before!.updatedBy, after!.updatedBy],
      },
    ] as const;
  }),
);
const metadataLeaf = (key: string, leaf: { path: string; a: unknown; b: unknown }) => {
  const expected = metadata.get(key);
  const field = /^\/updateTracker\/descriptions\/en\/(lastUpdate|updatedBy)$/.exec(
    leaf.path,
  )?.[1] as 'lastUpdate' | 'updatedBy' | undefined;
  return Boolean(
    expected && field && expected[field][0] === leaf.a && expected[field][1] === leaf.b,
  );
};
const now = Date.parse('2026-11-11T00:00:00Z');
const exportInput = (files: Record<string, string>) => {
  const tooltips: Tooltip[] = Object.values(files).map((bytes) =>
    tooltipSchema.parse(JSON.parse(bytes)),
  );
  const perks = exportLegacy(tooltips, now, facts, aliases);
  const bytes = JSON.stringify({ perks });
  // The converter reads the serialized file, as the legacy job does.
  return { bytes, input: JSON.parse(bytes) as LegacyInput };
};
const A = exportInput(beforeFiles);
if (process.env.MULT_DUMP_INPUT) writeFileSync(process.env.MULT_DUMP_INPUT, A.bytes);
const B = exportInput(afterFiles);

const rows = (json(need('rows')) as { rows: Row[] }).rows;
/**
 * A row's changed span: its before and after lines minus their common prefix and suffix, both cut
 * back to whole words. Consumers split a line at markup (a link or title after the edited words),
 * so their strings hold that span, not always the whole line.
 */
const changedSpan = (before: string, after: string): [string, string] => {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  while (start > 0 && before[start - 1] !== ' ') start--;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  while (end > 0 && before[before.length - end] !== ' ') end--;
  return [before.slice(start, before.length - end), after.slice(start, after.length - end)];
};
const apply = (text: string, group: readonly Row[]) => {
  let result = text;
  for (const { before, after } of group) result = result.split(before).join(after);
  for (const [before, after] of group.map((row) => changedSpan(row.before, row.after))) {
    result = result.split(before).join(after);
  }
  return result;
};
// Spans of different rows can overlap ("...Multiplier" vs "...Multiplier."), so a consumer string
// is checked against each row alone, then each file's rows together (a whole-text string holds
// several lines), then all rows. It passes only if one of these gives the after string exactly.
const fileRows = new Map<string, Row[]>();
for (const row of rows)
  fileRows.set(row.authoredFile, [...(fileRows.get(row.authoredFile) ?? []), row]);
const byFile = [...fileRows.values()];
const groups = [...rows.map((row) => [row]), ...byFile.filter((group) => group.length > 1), rows];
/** Whether `after` is `before` with one approved group of row edits applied. */
const isRowEdit = (before: string, after: string) =>
  groups.some((group) => apply(before, group) === after);

type Leaf = { path: string; a: unknown; b: unknown };
const leaves = (a: unknown, b: unknown, path: string, out: Leaf[]) => {
  if (typeof a === 'object' && a && typeof b === 'object' && b) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.join('\u0000') !== keysB.join('\u0000') || Array.isArray(a) !== Array.isArray(b)) {
      out.push({ path: `${path} (keys)`, a: keysA, b: keysB });
      return;
    }
    for (const key of keysA) {
      leaves(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}/${key}`,
        out,
      );
    }
  } else if (a !== b) out.push({ path, a, b });
};

const out = resolve(need('out'));
mkdirSync(out, { recursive: true });
const summary: Record<string, unknown> = {
  method:
    'exportLegacy(all stored tooltips, now 2026-11-11T00:00:00Z, generator facts, aliases) -> buildLegacy(preset, pinned editorData identical list)',
  beforeInputSha256: sha256(A.bytes),
  afterInputSha256: sha256(B.bytes),
  pinnedEditorDataInputSha256: pinned.inputSha256,
  beforeInputEqualsPinnedFixture: sha256(A.bytes) === pinned.inputSha256,
  inputChangedPerks: Object.keys(A.input.perks).filter(
    (hash) => JSON.stringify(A.input.perks[hash]) !== JSON.stringify(B.input.perks[hash]),
  ),
  presets: {},
};
const presets: Record<string, unknown> = {};
const union = new Set<string>();
const textKeys = new Set<string>();
let failures = 0;
for (const preset of legacyPresets) {
  const bytesA = Buffer.from(buildLegacy(A.input, preset, { identical })).toString('utf8');
  const bytesB = Buffer.from(buildLegacy(B.input, preset, { identical })).toString('utf8');
  const a = JSON.parse(bytesA) as Record<string, unknown>;
  const b = JSON.parse(bytesB) as Record<string, unknown>;
  const problems: string[] = [];
  if (Object.keys(a).join(',') !== Object.keys(b).join(',')) problems.push('top-level keys differ');
  const changed = Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  const diff: Record<string, Leaf[]> = {};
  let metadataLeaves = 0;
  const metadataKeys = new Set<string>();
  for (const key of changed) {
    const list: Leaf[] = [];
    leaves(a[key], b[key], '', list);
    diff[key] = list;
    for (const leaf of list) {
      if (metadataLeaf(key, leaf)) {
        metadataLeaves += 1;
        metadataKeys.add(key);
      } else if (typeof leaf.a !== 'string' || typeof leaf.b !== 'string') {
        problems.push(`${key}${leaf.path}: non-string change`);
      } else if (!isRowEdit(leaf.a, leaf.b)) {
        problems.push(`${key}${leaf.path}: change is not exactly the row edits`);
      }
    }
    union.add(key);
    if (diff[key]!.some((leaf) => !metadataLeaf(key, leaf))) textKeys.add(key);
  }
  // Byte identity outside the changed keys: B with the changed values put back, written by the
  // engine's own serializer (legacy.ts buildLegacy), equals A byte for byte.
  const restored = JSON.parse(bytesB) as Record<string, unknown>;
  for (const key of changed) restored[key] = a[key];
  const reserialized = (value: unknown) => customJsonStringify(value, layoutProperties);
  if (reserialized(a) !== bytesA)
    problems.push('engine serializer does not reproduce before bytes');
  if (reserialized(restored) !== bytesA) problems.push('bytes outside changed keys differ');
  if (reserialized(b) !== bytesB) problems.push('after layout differs');
  failures += problems.length;
  presets[preset] = {
    beforeSha256: sha256(bytesA),
    afterSha256: sha256(bytesB),
    pinnedFixtureSha256: pinned.files[preset],
    beforeEqualsPinned: sha256(bytesA) === pinned.files[preset],
    keys: Object.keys(a).length,
    changedKeys: changed.length,
    changedLeaves: Object.values(diff).reduce((sum, list) => sum + list.length, 0),
    textChangedKeys: changed.filter((key) => diff[key]!.some((leaf) => !metadataLeaf(key, leaf)))
      .length,
    metadataLeaves,
    metadataKeys: metadataKeys.size,
    problems,
  };
  writeFileSync(join(out, `${preset}.diff.json`), `${JSON.stringify(diff, null, 1)}\n`);
}
summary.presets = presets;
summary.changedKeysUnion = [...union].map(Number).sort((x, y) => x - y);
summary.textChangedKeysUnion = [...textKeys].map(Number).sort((x, y) => x - y);
summary.metadataOnlyKeys = [...union]
  .filter((key) => !textKeys.has(key))
  .map(Number)
  .sort((x, y) => x - y);
summary.failures = failures;
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
console.log(
  JSON.stringify(
    { ...summary, changedKeysUnion: union.size, textChangedKeysUnion: textKeys.size },
    null,
    1,
  ),
);
if (failures) process.exitCode = 1;
