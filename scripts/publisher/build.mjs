import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { maxBuffer } from './childProcess.mjs';
// PUBLISHER_DIST lets a test build into its own directory (default: the shared dist).
const dist = process.env.PUBLISHER_DIST ?? 'scripts/publisher/dist';
await build({
  entryPoints: ['scripts/publisher/cli.ts'],
  outfile: `${dist}/publisher.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
const runtime = readFileSync(`${dist}/publisher.mjs`, 'utf8');
copyFileSync(
  'scripts/publisher/template/.publisher/verify-publication.mjs',
  `${dist}/verify-publication.mjs`,
);
// R16: a PIN declares `scheduledBatches` only for a runtime that really drains batch requests
// (the claim, the batch RECORD, and the P1 batch request schema), so the Worker's schedule
// admission (apps/worker/src/schedule) can never trust a build that would leave them pending.
for (const marker of ['Claim batch ', 'recordBatch(', 'batchPublishPayloadSchema'])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks scheduled batches (${marker}); refusing its PIN`);
// Likewise `markupBraces` only for a runtime whose exportLegacy lowers `#{d}` and `<enhanced/>`
// (core braces.ts lowerConsumerMarkup) and whose unloweredEntry refuses any `#{` left over, so the
// Worker's save guard (apps/worker/src/elementTags.ts) never trusts a build that would ship them.
for (const marker of ['lowerConsumerMarkup(', 'text.includes("#{")'])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks markup braces (${marker}); refusing its PIN`);
// And `prismaticTags` only for a runtime whose element-tag list holds Prismatic: a build declaring
// `elementTags` from before Prismatic joined leaves `<prismatic Text />` unlowered (text lost).
if (!/elementTagNames = \[[^\]]*"prismatic"/.test(runtime))
  throw new Error('Publisher runtime lacks Prismatic element tags; refusing its PIN');
for (const marker of ['applyInactiveLive(', 'inactiveRemovalHash(', 'config/inactive.json'])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks inactive moves (${marker})`);
if (!runtime.includes('replaceAll("<arrow/>"'))
  throw new Error('Publisher runtime lacks arrow symbol support; refusing its PIN');
if (!runtime.includes('lowerExoticMarkup('))
  throw new Error('Publisher runtime lacks Exotic tag lowering; refusing its PIN');
// Number tokens must resolve from each tooltip's English map before consumer markup lowers.
for (const marker of ['resolveNumberTokens(', 'validateNumberTooltip(', 'numberValues('])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks number tokens (${marker}); refusing its PIN`);
for (const marker of [
  'config/alias-groups.json',
  'composeAliases(',
  'Incomplete pinned alias facts',
  'Generator revision differs from frozen alias-group receipt',
  'aliasKind === "name"',
])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks alias groups (${marker}); refusing its PIN`);
for (const marker of [
  'globals/layout.json',
  'globals/live/',
  'planGlobalRelease(',
  'casMany(',
  'Sync pending: global dependency review required',
  'globalsConfigWithoutMarksV1',
])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks globals release (${marker}); refusing its PIN`);
for (const marker of [
  'var SchedulePreparer = class',
  'matchesPreparationFence(',
  'canClaimPreparedBatch(',
  'verifyPreparedPublication(',
  'Cannot restore superseded publication',
  'Schedule preparation CAS exhausted',
  'Scheduled global source is not in data branch history',
  'Draft batch staging changed during preparation',
  'Signed staged-save manifest mismatch',
])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks schedule preparation (${marker}); refusing its PIN`);
for (const marker of ['drainCurrentSaves(', 'Invalid staged Current save signature'])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks staged Current saves (${marker}); refusing its PIN`);
for (const marker of [
  'Installed publisher lacks globalsExportsV1',
  'Expected aggregate 1, 2, or 3',
])
  if (!runtime.includes(marker))
    throw new Error(`Publisher runtime lacks globals exports (${marker}); refusing its PIN`);
writeFileSync(
  `${dist}/PIN`,
  JSON.stringify(
    {
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer }).trim(),
      sha256: createHash('sha256')
        .update(readFileSync(`${dist}/publisher.mjs`))
        .digest('hex'),
      verifierSha256: createHash('sha256')
        .update(readFileSync(`${dist}/verify-publication.mjs`))
        .digest('hex'),
      // What this build can do; the Worker reads it at the data head (apps/worker/src/elementTags.ts):
      // elementTags = exportLegacy lowers element-tagged text to today's `<solar/>Scorch`;
      // sandboxPointers = maintainer picks in config/sandbox-pointers.json join the aliases
      // (apps/worker/src/sandboxPointers.ts refuses saving picks while the PIN lacks it);
      // scheduledBatches = `batch` requests are claimed, published, and activated (scheduled
      // changes P4; the Worker refuses scheduling while the PIN lacks it, spec I6);
      // markupBraces = exportLegacy lowers `#{d}` and `<enhanced/>` to today's `#d` and `#e`
      // (the Worker refuses saving them while the PIN lacks it);
      // prismaticTags = exportLegacy lowers `<prismatic Text />` too (elementTags builds from before
      // Prismatic joined do not; the Worker refuses Prismatic tags while the PIN lacks it).
      // arrowSymbol = retain <arrow/> in the intermediate; the separately installed converter engine lowers legacy files.
      // numberTokens = validate English maps and resolve translation tokens before export.
      capabilities: [
        'elementTags',
        'sandboxPointers',
        'scheduledBatches',
        'markupBraces',
        'prismaticTags',
        'inactiveMoves',
        'arrowSymbol',
        'numberTokens',
        'aliasGroups',
        'globalsRelease',
        'globalsExportsV1',
        'globalsConfigWithoutMarksV1',
        'scheduledGlobalsV1',
        'schedulePreparationV1',
        'draftBatchStagingV1',
        'scheduledBatchStagingV1',
        'currentSaveStagingV1',
        'exoticTags',
      ],
    },
    null,
    2,
  ) + '\n',
);
if (process.argv.includes('--template')) {
  const target = 'scripts/publisher/template/.publisher';
  mkdirSync(target, { recursive: true });
  for (const file of ['publisher.mjs', 'PIN']) copyFileSync(`${dist}/${file}`, `${target}/${file}`);
}

await build({
  entryPoints: ['scripts/publisher/parity.ts'],
  outfile: `${dist}/parity.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
