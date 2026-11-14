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
writeFileSync(
  `${dist}/PIN`,
  JSON.stringify(
    {
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer }).trim(),
      sha256: createHash('sha256')
        .update(readFileSync(`${dist}/publisher.mjs`))
        .digest('hex'),
      // What this build can do; the Worker reads it at the data head (apps/worker/src/elementTags.ts):
      // elementTags = exportLegacy lowers element-tagged text to today's `<solar/>Scorch`;
      // sandboxPointers = maintainer picks in config/sandbox-pointers.json join the aliases
      // (apps/worker/src/sandboxPointers.ts refuses saving picks while the PIN lacks it);
      // scheduledBatches = `batch` requests are claimed, published, and activated (scheduled
      // changes P4; the Worker refuses scheduling while the PIN lacks it, spec I6);
      // markupBraces = exportLegacy lowers `#{d}` and `<enhanced/>` to today's `#d` and `#e`
      // (the Worker refuses saving them while the PIN lacks it).
      capabilities: ['elementTags', 'sandboxPointers', 'scheduledBatches', 'markupBraces'],
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
