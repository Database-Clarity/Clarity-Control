// Usage: node scripts/drafting/cli.mjs inputs <evidence-directory>
//        node scripts/drafting/cli.mjs validate <evidence-directory> <batch-input.json> <batch-output.json>
// Writes suggestions/evidence only. This tool deliberately has no git write or publish operation.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildInputs, selectSample, validateDraft } from './pipeline.mjs';

const root = process.env.DRAFTING_APP_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const [command, directory, inputFile, outputFile] = process.argv.slice(2);
if (!directory || !['inputs', 'offline', 'validate'].includes(command))
  throw new Error(
    'Usage: cli.mjs inputs|offline <dir> | validate <dir> <batch-input> <batch-output>',
  );
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const write = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
await mkdir(directory, { recursive: true });
const server = await createServer({
  root,
  configFile: false,
  resolve: { alias: { '@clarity/core': path.join(root, 'packages/core/src/index.ts') } },
  server: { middlewareMode: true, hmr: false },
});
try {
  const load = (file) => server.ssrLoadModule(path.join(root, file));
  const modules = await Promise.all(
    [
      'packages/core/src/index.ts',
      'apps/web/src/services/generatorSchema.ts',
      'apps/web/src/services/bundleSchema.ts',
      'apps/web/src/features/compendium/reviewQueue.ts',
      'apps/web/src/features/compendium/rapidReview.ts',
      'apps/web/src/features/compendium/reviewProgress.ts',
      'apps/web/src/features/compendium/displayMatches.ts',
      'apps/web/src/features/compendium/sourceLocation.ts',
      'apps/web/src/services/editorDrafts.ts',
      'apps/web/src/features/navigation/catalog.ts',
      'apps/web/src/services/tooltipImports.ts',
      'apps/web/src/features/tooltip/variants.ts',
    ].map(load),
  );
  const app = Object.assign({}, ...modules, {
    scope:
      'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json|https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json',
  });
  if (command === 'inputs' || command === 'offline') {
    const repositories = {
      generator: ['Description-data-generator', 'v2'],
      bundle: ['Live-Clarity-Database', 'editor-data-bundle'],
      compendium: ['Compendium-data', 'main'],
    };
    const saved =
      command === 'offline' ? await read(path.join(directory, 'snapshot.json')) : undefined;
    const pins =
      saved?.pins ??
      Object.fromEntries(
        Object.entries(repositories).map(([id, [repo, branch]]) => [
          id,
          execFileSync(
            'gh',
            ['api', `repos/Database-Clarity/${repo}/commits/${branch}`, '--jq', '.sha'],
            { encoding: 'utf8' },
          ).trim(),
        ]),
      );
    const fetchJson = async (id, file) => {
      const response = await fetch(
        `https://raw.githubusercontent.com/Database-Clarity/${repositories[id][0]}/${pins[id]}/${file}`,
      );
      if (!response.ok) throw new Error(`Input HTTP ${response.status}: ${id}/${file}`);
      return response.json();
    };
    const [items, categories, aliases, bundle, rawSource] = saved
      ? [
          saved.editor.items,
          saved.editor.categories,
          saved.editor.aliases,
          saved.editor.bundle,
          saved.source,
        ]
      : await Promise.all([
          fetchJson('generator', 'templates/v2/items.json'),
          fetchJson('generator', 'templates/v2/categories.json'),
          fetchJson('generator', 'templates/v2/aliases.json'),
          fetchJson('bundle', 'bundle.json'),
          fetchJson('compendium', 'compendium.json'),
        ]);
    const editor = {
      items: app.itemsSchema.parse(items),
      categories: categories.map((c) => app.categorySchema.parse(c)),
      aliases: app.aliasesSchema.parse(aliases),
      bundle: app.bundleSchema.parse(bundle),
    };
    const source = app.compendiumDataSchema.parse(rawSource);
    source.tabs = source.tabs.filter((tab) => app.isTrackedCompendiumTab(tab.name));
    const result = app.withCompendiumMatchingIndex(source, () =>
      buildInputs(editor, source, pins.compendium, app, {
        includeExoticWeapons: process.env.DRAFTING_INCLUDE_EXOTIC_WEAPONS === '1',
      }),
    );
    await write(path.join(directory, 'snapshot.json'), { editor, source, pins });
    await write(path.join(directory, 'inputs.json'), {
      ...result,
      pins,
      bundleCommit: editor.bundle.sourceCommit,
    });
    await write(path.join(directory, 'sample-input.json'), selectSample(result.items));
    console.log(
      JSON.stringify(
        {
          pins,
          counts: result.counts,
          sample: selectSample(result.items).map(({ hash, name, group, baseExotic }) => ({
            hash,
            name,
            group,
            base: baseExotic?.name,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    if (!inputFile || !outputFile)
      throw new Error('validate requires batch input and output paths');
    const { editor } = await read(path.join(directory, 'snapshot.json'));
    const inputs = await read(inputFile);
    const drafts = await read(outputFile);
    const errors = {};
    const accepted = {};
    const known = new Set(inputs.map((item) => String(item.hash)));
    for (const hash of Object.keys(drafts))
      if (hash !== '_meta' && !known.has(hash)) throw new Error(`Unexpected output hash: ${hash}`);
    for (const item of inputs) {
      const issues = validateDraft(item, drafts[item.hash], editor, app);
      if (issues.length) errors[item.hash] = issues;
      else accepted[item.hash] = drafts[item.hash];
    }
    await write(path.join(directory, 'validation.json'), { accepted, errors });
    // Validation produces evidence only. Owner-facing HTML must go through the
    // exact-digest independent-critique gate in fresh.mjs.
    console.log(JSON.stringify({ accepted: Object.keys(accepted).length, errors }, null, 2));
    if (Object.keys(errors).length) process.exitCode = 1;
  }
} finally {
  await server.close();
}
