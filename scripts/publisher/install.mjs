import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const [checkoutArg, configArg, mode = '--plan'] = process.argv.slice(2);
if (!checkoutArg || !configArg || !['--plan', '--apply-local'].includes(mode))
  throw new Error('Usage: install.mjs <editor-data checkout> <config.json> [--plan|--apply-local]');
const checkout = resolve(checkoutArg);
const git = (...args) =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
if (git('branch', '--show-current') !== 'editor-data' || git('status', '--porcelain'))
  throw new Error('Clean editor-data checkout required');
if (
  !/^(https:\/\/github.com\/|git@github.com:)Database-Clarity\/Live-Clarity-Database(?:\.git)?$/.test(
    git('remote', 'get-url', 'origin'),
  )
)
  throw new Error('Unexpected remote');
const template = resolve('scripts/publisher/template');
const pin = JSON.parse(readFileSync(join(template, '.publisher/PIN')));
if (
  createHash('sha256')
    .update(readFileSync(join(template, '.publisher/publisher.mjs')))
    .digest('hex') !== pin.sha256
)
  throw new Error('PIN mismatch');
const config = JSON.parse(readFileSync(resolve(configArg)));
if (
  config.repo !== 'Database-Clarity/Live-Clarity-Database' ||
  config.dataBranch !== 'editor-data' ||
  config.liveBranch !== 'converter-v2-test' ||
  config.publisherSha !== pin.sourceSha ||
  !/^[a-f0-9]{40}$/.test(config.generatorSha) ||
  !/^[a-f0-9]{64}$/.test(config.keyFingerprint) ||
  !Object.keys(config.facts ?? {}).length ||
  new URL(config.keyEndpoint).protocol !== 'https:' ||
  JSON.stringify(config).includes('REPLACE') ||
  JSON.stringify(config).includes('PRIVATE KEY')
)
  throw new Error('Complete verified public config required');
console.log(
  'Plan: retire bundle.yml; copy pipeline.yml and pinned .publisher; install public config. Publish transport remains dry-run. No commit/push.',
);
if (mode === '--apply-local') {
  const dir = join(checkout, '.publisher');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(join(template, '.publisher')))
    if (f !== 'config.example.json') copyFileSync(join(template, '.publisher', f), join(dir, f));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  mkdirSync(join(checkout, '.github/workflows'), { recursive: true });
  copyFileSync(
    join(template, '.github/workflows/pipeline.yml'),
    join(checkout, '.github/workflows/pipeline.yml'),
  );
  const old = join(checkout, '.github/workflows/bundle.yml');
  if (existsSync(old)) rmSync(old);
  console.log(
    'Local files prepared. Review git diff and run actionlint before an operator commits.',
  );
}
