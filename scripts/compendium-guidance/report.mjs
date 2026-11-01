// Read-only remote inputs and owner guidance; only writes the explicitly named new output directory.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const [guidanceFile, output] = process.argv.slice(2);
if (!guidanceFile || !output)
  throw new Error(
    'Usage: node scripts/compendium-guidance/report.mjs <guidance.json> <new-output-directory>',
  );
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true, hmr: false },
});
try {
  const load = (file) => server.ssrLoadModule(path.join(root, file));
  const [core, generator, bundleModule, schema, queue, categoriesModule, progress, rapid, guided] =
    await Promise.all([
      load('packages/core/src/index.ts'),
      load('apps/web/src/services/generator.ts'),
      load('apps/web/src/services/bundle.ts'),
      load('apps/web/src/features/compendium/guidanceSchema.ts'),
      load('apps/web/src/features/compendium/reviewQueue.ts'),
      load('apps/web/src/features/compendium/reviewCategories.ts'),
      load('apps/web/src/features/compendium/reviewProgress.ts'),
      load('apps/web/src/features/compendium/rapidReview.ts'),
      load('apps/web/src/features/compendium/guidedDecisions.ts'),
    ]);
  const sourceUrl =
    'https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json';
  const raw = await readFile(guidanceFile);
  const document = schema.guidanceSchema.parse(JSON.parse(raw.toString('utf8')));
  const response = await fetch(sourceUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Compendium HTTP ${response.status}`);
  const source = core.compendiumDataSchema.parse(await response.json());
  const [catalog, bundle] = await Promise.all([
    generator.loadGenerator(),
    bundleModule.loadBundle(),
  ]);
  const editor = { ...catalog, bundle };
  const fingerprint = progress.sourceFingerprint(source.tabs);
  const baseline = `${bundle.sourceCommit}|${fingerprint}`;
  const entries = queue.reviewQueue(editor, source, {}, progress.emptyProgress(), fingerprint);
  const proposals = new Map(
    entries.map((entry) => [entry.hash, rapid.proposalFor(entry.base, editor, source)]),
  );
  const categories = categoriesModule.reviewCategories(entries, editor, proposals, false);
  const groups = guided.guidedDecisions(
    document,
    categories,
    proposals,
    source,
    baseline,
    `${bundleModule.bundleUrl}|${sourceUrl}`,
  );
  const result = {
    version: 1,
    mode: 'preview-only',
    guidanceSha256: createHash('sha256').update(raw).digest('hex'),
    guidanceBaseline: document.baseline,
    currentBaseline: baseline,
    baselineMatches: document.baseline === baseline,
    scope: document.scope,
    revision: guided.guidedRevision(groups),
    high: groups.reduce((sum, group) => sum + group.high, 0),
    owner: groups.reduce((sum, group) => sum + group.unresolved, 0),
    currentQueueCount: entries.length,
    groups,
  };
  // Refuse to overwrite an earlier report or the guidance itself.
  await mkdir(output);
  await writeFile(path.join(output, 'proposals.json'), JSON.stringify(result, null, 2), {
    flag: 'wx',
  });
  await writeFile(
    path.join(output, 'summary.md'),
    [
      '# Guided Compendium proposal preview',
      '',
      `Guidance SHA256: ${result.guidanceSha256}`,
      `Guidance baseline: ${document.baseline}`,
      `Current baseline: ${baseline}`,
      `Baseline matches: ${result.baselineMatches}`,
      `High confidence: ${result.high}; owner/unresolved: ${result.owner}. No drafts or writes to remote data.`,
      '',
      '| Category | High | Owner | Issues |',
      '| --- | ---: | ---: | --- |',
      ...groups.map(
        (group) => `| ${group.id} | ${group.high} | ${group.unresolved} | ${group.issues.length} |`,
      ),
      '',
      'Full per-entry scope, evidence, supporting references, source snapshots and reasons: proposals.json.',
    ].join('\n'),
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      high: result.high,
      owner: result.owner,
      baselineMatches: result.baselineMatches,
      baseline,
      output,
    }),
  );
} finally {
  await server.close();
}
