// Run through heavy.py: node scripts/globals/dry-run.mjs --snapshot <snapshot.json>
// Snapshot = {repository, revision, tooltips, aliases, types, mode, sources}.
// sources[hash][lang] = {path, selector}: actual repository path and decoded JSON keys.
// For a legacy JSON file, also supply --repository, --revision, and --source-path.
// This tool has no data-writing mode. IDs are proposals, never migration authorization.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values } = parseArgs({
  options: {
    snapshot: { type: 'string' },
    legacy: { type: 'string' },
    repository: { type: 'string' },
    revision: { type: 'string' },
    'source-path': { type: 'string' },
  },
});
if (Boolean(values.snapshot) === Boolean(values.legacy))
  throw new Error('Expected exactly one of --snapshot <snapshot.json> or --legacy <legacy.json>');
if (values.legacy && (!values.repository || !values.revision || !values['source-path']))
  throw new Error('Legacy input requires --repository, --revision, and --source-path provenance');
const input = JSON.parse(readFileSync(values.snapshot ?? values.legacy, 'utf8'));
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('./census.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { globalsCensus, legacyGlobalsCensus } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
let result;
if (values.snapshot) {
  const { sources, ...snapshot } = input;
  result = globalsCensus(snapshot, (hash, lang) => {
    const location = sources?.[hash]?.[lang];
    if (!location) throw new Error(`Missing source location for ${hash}/${lang}`);
    return location;
  });
} else
  result = legacyGlobalsCensus(input, {
    repository: values.repository,
    revision: values.revision,
    path: values['source-path'],
  });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (
  !result.aggregateParity ||
  !result.consumerInputParity ||
  !result.renderedParity ||
  !result.resolverComplete
)
  process.exitCode = 1;
