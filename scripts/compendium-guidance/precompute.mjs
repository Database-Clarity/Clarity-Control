// Read-only public inputs, immutable shipped approvals; writes only the app's computed asset.
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true, hmr: false },
});
try {
  const load = (file) => server.ssrLoadModule(path.join(root, file));
  const [core, generator, bundles, queue, rapid, progress, display, codec, inputs] =
    await Promise.all(
      [
        'packages/core/src/index.ts',
        'apps/web/src/services/generator.ts',
        'apps/web/src/services/bundle.ts',
        'apps/web/src/features/compendium/reviewQueue.ts',
        'apps/web/src/features/compendium/rapidReview.ts',
        'apps/web/src/features/compendium/reviewProgress.ts',
        'apps/web/src/features/compendium/displayMatches.ts',
        'apps/web/src/features/compendium/precomputedCodec.ts',
        'apps/web/src/features/compendium/matchingInputs.ts',
      ].map(load),
    );
  const url =
    'https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Compendium HTTP ${response.status}`);
  const source = core.compendiumDataSchema.parse(await response.json());
  source.tabs = source.tabs.filter((tab) => core.isTrackedCompendiumTab(tab.name));
  const editor = { ...(await generator.loadGenerator()), bundle: await bundles.loadBundle() };
  const proposals = new Map(
    queue
      .reviewEvidence(editor, source, {}, '')
      .map((entry) => [entry.hash, rapid.proposalFor(entry.base, editor, source)]),
  );
  const result = display.displayMatches(
    editor,
    source,
    {},
    progress.emptyProgress(),
    undefined,
    `${bundles.bundleUrl}|${url}`,
    proposals,
  );
  const compactMatch = (match) =>
    match && { ...match, tab: { ...match.tab, rows: [], grid: undefined } };
  const value = {
    key: createHash('sha256')
      .update(JSON.stringify(inputs.matchingInputs(editor, source)))
      .digest('hex'),
    proposals: [...proposals].map(([hash, proposal]) => [
      hash,
      {
        ...proposal,
        match: compactMatch(proposal.match),
        candidates: proposal.candidates.map(compactMatch),
      },
    ]),
    display: {
      ...result,
      matches: [...result.matches].map(([hash, match]) => [hash, compactMatch(match)]),
    },
  };
  // JSON normalization drops optional undefined fields before interning the value table.
  const encoded = codec.encodePrecomputed(JSON.parse(JSON.stringify(value)));
  await writeFile(
    path.join(root, 'apps/web/src/features/compendium/precomputed.v1.json'),
    JSON.stringify(encoded) + '\n',
  );
  console.log(
    `Computed ${result.matches.size} eligible matches; source ${source.fetchedAt}; bundle ${editor.bundle.sourceCommit}.`,
  );
} finally {
  await server.close();
}
