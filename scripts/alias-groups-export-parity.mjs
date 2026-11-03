import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const [auditDir, dataRepo] = process.argv.slice(2);
if (!auditDir || !dataRepo)
  throw new Error(
    'Usage: node scripts/alias-groups-export-parity.mjs <audit directory> <editor-data repository>',
  );
const core = path.resolve('node_modules/.cache/alias-groups-core');
fs.mkdirSync(core, { recursive: true });
fs.writeFileSync(path.join(core, 'package.json'), '{"type":"module"}');
function compile(dir, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const input = path.join(dir, entry.name),
      output = path.join(target, entry.name.replace(/\.ts$/, '.js'));
    if (entry.isDirectory()) compile(input, output);
    else if (entry.name.endsWith('.ts'))
      fs.writeFileSync(
        output,
        ts.transpileModule(fs.readFileSync(input, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
        }).outputText,
      );
    else fs.copyFileSync(input, output);
  }
}
compile('packages/core/src', core);
const { exportLegacy } = await import(pathToFileURL(path.join(core, 'exportLegacy.js')));
const { readAliasProposals, enhancedWordingNeeded } = await import(
  pathToFileURL(path.join(core, 'aliasGroups.js'))
);
const dataRef = execFileSync('git', ['-C', dataRepo, 'rev-parse', 'origin/editor-data'], {
  encoding: 'utf8',
}).trim();
const archive = path.join(auditDir, 'tooltips.tar'),
  extracted = path.join(auditDir, 'editor-data');
fs.mkdirSync(extracted, { recursive: true });
execFileSync('git', ['-C', dataRepo, 'archive', '--output', archive, dataRef, 'tooltips']);
execFileSync('tar', ['-xf', archive, '-C', extracted]);
const tooltips = Object.fromEntries(
  fs
    .readdirSync(path.join(extracted, 'tooltips'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const t = JSON.parse(fs.readFileSync(path.join(extracted, 'tooltips', f)));
      return [t.hash, t];
    }),
);
const read = (side, file) =>
  JSON.parse(fs.readFileSync(path.join(auditDir, side, 'templates/v2', file + '.json')));
const exports = {},
  skipped = {};
for (const side of ['before', 'after']) {
  const items = read(side, 'items'),
    aliases = read(side, 'aliases'),
    categories = read(side, 'categories');
  const catalog = Object.fromEntries(
    Object.values(items).map((i) => [
      i.hash,
      {
        name: i.name,
        type: categories.find((c) => c.id === i.categoryId).legacyType ?? i.categoryId,
        ...(i.itemHash === undefined ? {} : { itemHash: i.itemHash, itemName: i.itemName }),
      },
    ]),
  );
  const included = Object.values(tooltips).filter(
    (t) => !aliases[t.hash] && (catalog[t.hash] || t.custom),
  );
  skipped[side] = Object.keys(tooltips)
    .map(Number)
    .filter((h) => !included.some((t) => t.hash === h));
  for (const t of included)
    if (!catalog[t.hash] && t.custom)
      catalog[t.hash] = { name: t.custom.name, type: t.custom.categoryId };
  exports[side] = exportLegacy(included, 0, catalog, aliases);
  fs.writeFileSync(
    path.join(auditDir, 'export-' + side + '.json'),
    JSON.stringify(exports[side], null, 2),
  );
}
const changedHashes = [...new Set([...Object.keys(exports.before), ...Object.keys(exports.after)])]
  .filter((h) => JSON.stringify(exports.before[h]) !== JSON.stringify(exports.after[h]))
  .map((hash) => ({
    hash: Number(hash),
    before: exports.before[hash],
    after: exports.after[hash],
  }));
const items = read('after', 'items');
const proposals = readAliasProposals(read('after', 'aliasProposals'), tooltips);
const counts = {};
for (const p of proposals) {
  const scope = p.basis.categoryId.startsWith('armor-')
    ? 'armor'
    : p.basis.categoryId.startsWith('subclass-')
      ? 'subclass'
      : 'weapon';
  const key = scope + ' ' + p.kind;
  const row = (counts[key] ??= { groups: 0, hashes: 0, bulk: 0, single: 0, conflict: 0 });
  row.groups++;
  row.hashes += p.members.length;
  row[p.textState === 'conflict' ? 'conflict' : p.bulkEligible ? 'bulk' : 'single']++;
}
const report = {
  dataRef,
  changedHashes,
  skipped,
  counts,
  enhancedWordingNeeded: enhancedWordingNeeded(items, read('after', 'aliases'), tooltips),
};
fs.writeFileSync(path.join(auditDir, 'export-parity.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    dataRef,
    exportChanges: changedHashes.length,
    counts,
    worklist: report.enhancedWordingNeeded.length,
  }),
);
