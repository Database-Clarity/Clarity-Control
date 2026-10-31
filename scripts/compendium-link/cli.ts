import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  aliasesSchema,
  autoLinkCompendium,
  compendiumDataSchema,
  contentHash,
  publishableHash,
  tooltipSchema,
  type Tooltip,
} from '../../packages/core/src/index.js';

const source = 'https://github.com/Database-Clarity/Live-Clarity-Database.git';
const itemSchema = z.object({
  hash: z.number(),
  name: z.string(),
  categoryId: z.string(),
  itemName: z.string().optional(),
  baseHash: z.number().optional(),
});
const itemsSchema = z.record(z.string(), itemSchema);
function git(args: string[], input?: string | Buffer, indexFile?: string): Buffer {
  return execFileSync('git', args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
  });
}
async function json(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
function readTooltips(head: string): { file: string; tooltip: Tooltip }[] {
  const files = git(['ls-tree', '-r', '--format=%(objectname) %(path)', head, 'tooltips'])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ sha: line.slice(0, 40), file: line.slice(41) }));
  const objects = git(['cat-file', '--batch'], files.map(({ sha }) => sha).join('\n') + '\n');
  let offset = 0;
  return files.map(({ file }) => {
    const end = objects.indexOf(10, offset);
    const size = Number(objects.subarray(offset, end).toString('utf8').split(' ')[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid git object for ${file}`);
    const tooltip = tooltipSchema.parse(
      JSON.parse(objects.subarray(end + 1, end + 1 + size).toString('utf8')),
    );
    offset = end + 1 + size + 1;
    if (file !== `tooltips/${tooltip.hash}.json`) throw new Error(`Hash/path mismatch: ${file}`);
    return { file, tooltip };
  });
}
const args = process.argv.slice(2);
const dataFile = args[0];
const output = args[1];
const approvedHead = args
  .find((value) => value.startsWith('--commit-approved-head='))
  ?.split('=')[1];
if (!dataFile || !output)
  throw new Error(
    'Usage: cli <compendium.json> <report directory> [--commit-approved-head=<40-char data HEAD>]',
  );
if (approvedHead && !/^[0-9a-f]{40}$/.test(approvedHead))
  throw new Error('Approval must identify an exact data-branch HEAD');
git(['fetch', '--no-tags', source, 'refs/heads/editor-data']);
const head = git(['rev-parse', 'FETCH_HEAD']).toString('utf8').trim();
if (approvedHead && head !== approvedHead)
  throw new Error(`Data branch advanced to ${head}; repeat dry run and request fresh approval`);
const generator =
  'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2';
const [items, aliases, data] = await Promise.all([
  json(`${generator}/items.json`).then((value) => itemsSchema.parse(value)),
  json(`${generator}/aliases.json`).then((value) => aliasesSchema.parse(value)),
  readFile(dataFile, 'utf8').then((value) => compendiumDataSchema.parse(JSON.parse(value))),
]);
const now = new Date().toISOString();
const tooltips = readTooltips(head);
const tooltipIndex = Object.fromEntries(tooltips.map(({ tooltip }) => [tooltip.hash, tooltip]));
const results = tooltips.map(({ tooltip }) =>
  autoLinkCompendium(tooltip, items, aliases, data, now, tooltipIndex),
);
const changes: { file: string; tooltip: Tooltip }[] = [];
for (const [index, result] of results.entries()) {
  if (tooltips[index].tooltip.compendium && result.next)
    throw new Error(`Refusing to rewrite existing link ${result.hash}`);
  if (!result.next) continue;
  const before = tooltips[index];
  if ((await publishableHash(before.tooltip)) !== (await publishableHash(result.next))) {
    throw new Error(`Refusing publishable change to ${result.hash}`);
  }
  if ((await contentHash(before.tooltip)) !== (await contentHash(result.next))) {
    changes.push({ file: before.file, tooltip: result.next });
  }
}
await mkdir(output, { recursive: true });
const quote = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
const csv =
  [
    ['hash', 'name', 'category', 'reason', 'top candidates'],
    ...results
      .filter((result) => result.reason !== 'linked')
      .map((result) => [
        result.hash,
        result.name,
        result.category,
        result.reason,
        result.candidates
          .map(
            (candidate) =>
              `${candidate.tab.name}/${candidate.row.name} [${candidate.row.section ?? ''}] (${Math.round(candidate.similarity * 100)}%)`,
          )
          .join(' | '),
      ]),
  ]
    .map((row) => row.map(quote).join(','))
    .join('\n') + '\n';
await writeFile(path.join(output, 'compendium-unlinked.csv'), csv);
const categories = [...new Set(results.map((result) => result.category))]
  .sort()
  .map((category) => ({
    category,
    linked: results.filter((result) => result.category === category && result.reason === 'linked')
      .length,
    total: results.filter((result) => result.category === category).length,
  }));
const summary = {
  head,
  fetchedAt: data.fetchedAt,
  total: tooltips.length,
  linked: results.filter((result) => result.reason === 'linked').length,
  combined: results.filter(
    (result, index) => (result.next ?? tooltips[index].tooltip).compendium?.parts?.length,
  ).length,
  needsCellOverride: results.filter(
    (result) => result.reason === 'ambiguous' || result.reason === 'unmatched',
  ).length,
  ambiguous: results.filter((result) => result.reason === 'ambiguous').length,
  unmatched: results.filter((result) => result.reason === 'unmatched').length,
  noEquivalent: results.filter((result) => result.reason === 'no-equivalent').length,
  metadataChanges: changes.length,
  publishableChanges: 0,
  preservedExistingLinks: tooltips.filter(({ tooltip }) => tooltip.compendium).length,
  rewrittenExistingLinks: 0,
  categories,
};
await writeFile(path.join(output, 'coverage.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(path.join(output, 'baseline.json'), JSON.stringify(changes) + '\n');
console.info(JSON.stringify(summary, null, 2));
if (approvedHead && changes.length) {
  const treeInput = changes
    .map(({ file, tooltip }) => {
      const blob = git(['hash-object', '-w', '--stdin'], JSON.stringify(tooltip, null, 2) + '\n')
        .toString('utf8')
        .trim();
      return `100644 ${blob}\t${file}\n`;
    })
    .join('');
  const indexFile = path.resolve(output, 'baseline.git-index');
  try {
    git(['read-tree', head], undefined, indexFile);
    git(['update-index', '--index-info'], treeInput, indexFile);
    const tree = git(['write-tree'], undefined, indexFile).toString('utf8').trim();
    const message = `Snapshot Compendium baselines for ${changes.length} tooltips\n\nMetadata only; all publishable hashes remain unchanged.\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;
    const commit = git(['commit-tree', tree, '-p', head, '-m', message]).toString('utf8').trim();
    git(['push', source, `${commit}:refs/heads/editor-data`]);
    console.info(`Published metadata-only baseline ${commit}`);
  } finally {
    await rm(indexFile, { force: true });
  }
}
