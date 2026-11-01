// Read-only remote inputs and owner guidance; only writes the explicitly named new output directory.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const renew = args.includes('--rebaseline');
const [guidanceFile, output, bundleFile] = args.filter((arg) => arg !== '--rebaseline');
if (!guidanceFile || !output)
  throw new Error(
    'Usage: node scripts/compendium-guidance/report.mjs <guidance.json> <new-output-directory> [historical-bundle.json]',
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
  let document = schema.guidanceSchema.parse(JSON.parse(raw.toString('utf8')));
  const response = await fetch(sourceUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Compendium HTTP ${response.status}`);
  const source = core.compendiumDataSchema.parse(await response.json());
  const [catalog, bundle] = await Promise.all([
    generator.loadGenerator(),
    bundleFile
      ? readFile(bundleFile, 'utf8').then((raw) => bundleModule.bundleSchema.parse(JSON.parse(raw)))
      : bundleModule.loadBundle(),
  ]);
  const editor = { ...catalog, bundle };
  const fingerprint = progress.sourceFingerprint(source.tabs);
  const baseline = `${bundle.sourceCommit}|${fingerprint}`;
  const entries = queue.reviewQueue(editor, source, {}, progress.emptyProgress(), fingerprint);
  const proposals = new Map(
    entries.map((entry) => [entry.hash, rapid.proposalFor(entry.base, editor, source)]),
  );
  const categories = categoriesModule.reviewCategories(entries, editor, proposals, false);
  const { inScopeCategory } = await load('apps/web/src/features/compendium/reviewScope.ts');
  const scope = `${bundleModule.bundleUrl}|${sourceUrl}`;
  let renewal;
  if (renew) {
    const { rebaselineGuidance } = await load(
      'apps/web/src/features/compendium/rebaselineGuidance.ts',
    );
    renewal = rebaselineGuidance(document, categories, source, baseline, scope);
    document = renewal.document;
  }
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
    mode: 'local-draft-preview',
    bundleInput: bundleFile ? 'historical-local-bundle' : bundleModule.bundleUrl,
    bundleSourceCommit: bundle.sourceCommit,
    guidanceSha256: createHash('sha256').update(raw).digest('hex'),
    guidanceBaseline: document.baseline,
    currentBaseline: baseline,
    baselineMatches: document.baseline === baseline,
    scope: document.scope,
    revision: guided.guidedRevision(groups),
    high: groups.reduce((sum, group) => sum + group.high, 0),
    medium: groups.reduce((sum, group) => sum + group.medium, 0),
    outOfScope: groups.reduce((sum, group) => sum + group.outOfScope, 0),
    owner: groups.reduce((sum, group) => sum + group.unresolved, 0),
    currentQueueCount: entries.length,
    reasonGroups: Object.fromEntries(
      categories
        .map(inScopeCategory)
        .map((category) => [
          category.id,
          Object.fromEntries(
            Object.entries(category.reasons).map(([reason, entries]) => [
              reason,
              entries.map((entry) => entry.hash),
            ]),
          ),
        ]),
    ),
    groups,
  };
  // Refuse to overwrite an earlier report or the guidance itself.
  await mkdir(output);
  if (renewal) {
    await writeFile(path.join(output, 'renewed-guidance.json'), JSON.stringify(document, null, 2), {
      flag: 'wx',
    });
    await writeFile(
      path.join(output, 'rebaseline-audit.json'),
      JSON.stringify(
        {
          inputSha256: createHash('sha256').update(raw).digest('hex'),
          baseline,
          renewed: renewal.renewed,
          changed: renewal.changed,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  }
  await writeFile(path.join(output, 'proposals.json'), JSON.stringify(result, null, 2), {
    flag: 'wx',
  });
  await writeFile(
    path.join(output, 'owner-tier.json'),
    JSON.stringify(
      groups.flatMap((group) => group.entries.filter((entry) => entry.confidence === 'unresolved')),
      null,
      2,
    ),
    { flag: 'wx' },
  );
  await writeFile(
    path.join(output, 'out-of-scope.json'),
    JSON.stringify(
      groups.flatMap((group) =>
        group.entries.filter((entry) => entry.confidence === 'out-of-scope'),
      ),
      null,
      2,
    ),
    { flag: 'wx' },
  );
  await writeFile(
    path.join(output, 'summary.md'),
    [
      '# Guided Compendium proposal preview',
      '',
      `Guidance SHA256: ${result.guidanceSha256}`,
      `Bundle input: ${result.bundleInput}; source commit: ${result.bundleSourceCommit}`,
      `Guidance baseline: ${document.baseline}`,
      `Current baseline: ${baseline}`,
      `Baseline matches: ${result.baselineMatches}`,
      `High confidence: ${result.high}; medium: ${result.medium}; owner/unresolved: ${result.owner}; out of scope: ${result.outOfScope}. No drafts or writes to remote data.`,
      '',
      '| Category | High | Medium | Owner | Out of scope | Issues |',
      '| --- | ---: | ---: | ---: | ---: | --- |',
      ...groups.map(
        (group) =>
          `| ${group.id} | ${group.high} | ${group.medium} | ${group.unresolved} | ${group.outOfScope} | ${group.issues.length} |`,
      ),
      '',
      'Full per-entry scope, evidence, supporting references, source snapshots and reasons: proposals.json.',
    ].join('\n'),
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      high: result.high,
      medium: result.medium,
      owner: result.owner,
      outOfScope: result.outOfScope,
      baselineMatches: result.baselineMatches,
      baseline,
      output,
      renewed: renewal?.renewed.length,
      changed: renewal?.changed.length,
    }),
  );
} finally {
  await server.close();
}
