import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const [auditDir, dataRepo, requestedDataRef = 'origin/editor-data'] = process.argv.slice(2);
const multibase = process.argv.includes('--multibase');
const enhancedFallback = process.argv.includes('--enhanced-fallback');
// Pinned notification-style corrections; Osmosis has no unambiguous base and no prior export.
const fallbackHashes = [270582335, 843406310, 1164602481, 1807646319, 1847323754, 2671305723];
if (!auditDir || !dataRepo)
  throw new Error(
    'Usage: node scripts/alias-groups-export-parity.mjs <audit directory> <editor-data repository> [pinned editor-data ref]',
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
const { readAliasProposals, enhancedWordingNeeded, effectiveAliases } = await import(
  pathToFileURL(path.join(core, 'aliasGroups.js'))
);
const dataRef = execFileSync('git', ['-C', dataRepo, 'rev-parse', requestedDataRef], {
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
// Owner-approved parity: only real legendary enhanced perks change export type.
const manifest = JSON.parse(fs.readFileSync(path.join(auditDir, 'manifest.json'))).manifest
  .inventoryItem;
const expectedHashes = Object.keys(exports.before)
  .filter((h) =>
    multibase
      ? false
      : enhancedFallback
        ? fallbackHashes.includes(Number(h))
        : exports.before[h].type === 'Weapon Perk' &&
          manifest[h]?.inventory?.tierType !== 6 &&
          /^Enhanced /.test(manifest[h]?.itemTypeDisplayName ?? ''),
  )
  .map(Number)
  .sort((a, b) => a - b);
const actualHashes = changedHashes.map((row) => row.hash).sort((a, b) => a - b);
if (JSON.stringify(expectedHashes) !== JSON.stringify(actualHashes))
  throw new Error('Unexpected export hash difference');
for (const row of changedHashes) {
  const expectedType = enhancedFallback
    ? { 'Weapon Trait': 'Weapon Trait Enhanced', 'Weapon Trait Origin': 'Weapon Trait Enhanced' }[
        row.before?.type
      ]
    : row.before?.type === 'Weapon Perk'
      ? 'Weapon Trait Enhanced'
      : undefined;
  if (!expectedType || row.after?.type !== expectedType)
    throw new Error(`Unexpected export type change ${row.hash}`);
  const { type: beforeType, ...before } = row.before,
    { type: afterType, ...after } = row.after;
  void beforeType;
  void afterType;
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(`Export bytes changed beyond type ${row.hash}`);
}
if (JSON.stringify(read('before', 'aliases')) !== JSON.stringify(read('after', 'aliases')))
  throw new Error('Generated aliases changed before approval');
const items = read('after', 'items');
for (const hash of expectedHashes) {
  const item = items[hash];
  if (item?.baseHash === undefined || !items[item.baseHash]?.enhancedHashes?.includes(hash))
    throw new Error(`Corrected exported enhancement ${hash} has no reciprocal base pairing`);
}
for (const item of Object.values(items)) {
  if (
    item.categoryId.endsWith('-exotic') &&
    (item.baseHash !== undefined ||
      item.enhancedHash !== undefined ||
      item.enhancedHashes !== undefined ||
      item.categoryId.includes('-enhanced'))
  )
    throw new Error(`Exotic enhanced mapping ${item.hash}`);
}
const proposalInput = read('after', 'aliasProposals');
const proposals = readAliasProposals(proposalInput, tooltips);
const owners = (item) =>
  new Set([...(item.owners ?? []), ...(item.itemHash === undefined ? [] : [item.itemHash])]);
const numbered = (item) => / (II|III|IV)$/.test(item.name);
const exoticFrameProposals = proposals.filter((p) => p.basis.exoticFrameOwner !== undefined);
for (const p of exoticFrameProposals) {
  const canonical = items[p.canonical];
  if (p.kind !== 'S' || p.basis.isEnhanced || numbered(canonical))
    throw new Error(`Invalid exotic frame canonical ${p.canonical}`);
  for (const hash of p.members) {
    const item = items[hash];
    if (
      item.categoryId !== 'weapon-frame-exotic' ||
      !owners(item).has(p.basis.exoticFrameOwner) ||
      (hash !== p.canonical && !numbered(item))
    )
      throw new Error(`Exotic frame member ${hash} crosses owner or category boundaries`);
  }
}
const possibleEnhanced = proposalInput.possibleEnhanced ?? [];
for (const pair of possibleEnhanced) {
  if (
    items[pair.variantHash]?.dimBaseHash !== pair.baseHash ||
    items[pair.variantHash]?.inGameDescription === items[pair.baseHash]?.inGameDescription ||
    proposals.some((p) => p.members.includes(pair.variantHash))
  )
    throw new Error(`Possible enhancement ${pair.variantHash} leaked into alias proposals`);
}
for (const p of proposals.filter((p) => p.kind === 'X')) {
  if (p.descriptionDiff !== 'identical' || p.bulkEligible)
    throw new Error(`Kind X ${p.canonical} is not an individual identical-wording review`);
}
// Check the actual emitted facts, with related base/enhanced groups accepted together.
const decisions = proposals.filter(
  (p) =>
    p.kind === 'S' &&
    (!p.basis.categoryId.startsWith('subclass-') || p.descriptionDiff === 'identical'),
);
const config = {
  version: 1,
  rejected: {},
  groups: Object.fromEntries(
    decisions.map((p) => [
      p.canonical,
      {
        members: p.members,
        kind: p.kind,
        basis: {
          name: p.basis.name,
          categoryId: p.basis.categoryId,
          ...(p.basis.exoticFrameOwner === undefined
            ? {}
            : { exoticFrameOwner: p.basis.exoticFrameOwner }),
        },
        by: { id: '1', login: 'audit' },
        at: '2026-11-03T00:00:00Z',
      },
    ]),
  ),
};
const effective = effectiveAliases(read('after', 'aliases'), config, items);
const nonSubclass = decisions.filter((p) => !p.basis.categoryId.startsWith('subclass-'));
for (const p of nonSubclass)
  for (const hash of p.members) {
    if (
      hash !== p.canonical &&
      effective.aliases[hash]?.to !== p.canonical &&
      !effective.issues.some(
        (i) =>
          i.canonical === p.canonical &&
          i.member === hash &&
          i.reason === 'Enhanced member no longer shares the canonical base group',
      )
    )
      throw new Error(`Emitted proposal member ${hash} failed fact validation for ${p.canonical}`);
  }
if (
  effective.issues.some(
    (i) => i.reason !== 'Enhanced member no longer shares the canonical base group',
  )
)
  throw new Error(JSON.stringify(effective.issues));
if (multibase && effective.issues.length) throw new Error(JSON.stringify(effective.issues));
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
  expectedExportHashes: expectedHashes,
  actualExportHashes: actualHashes,
  exportParityMatches: true,
  validatedNonSubclassGroups: nonSubclass.length,
  aliasGroupIssues: effective.issues,
  exoticFrameGroups: exoticFrameProposals.map((p) => ({
    canonical: p.canonical,
    members: p.members,
    owner: p.basis.exoticFrameOwner,
  })),
  possibleEnhanced,
  changedHashes,
  skipped,
  counts,
  enhancedWordingNeeded: enhancedWordingNeeded(items, read('after', 'aliases'), tooltips),
};
fs.writeFileSync(path.join(auditDir, 'export-parity.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    dataRef,
    validatedNonSubclassGroups: nonSubclass.length,
    exportChanges: changedHashes.length,
    counts,
    worklist: report.enhancedWordingNeeded.length,
  }),
);
