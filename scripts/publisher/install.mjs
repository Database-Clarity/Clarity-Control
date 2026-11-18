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
import { maxBuffer } from './childProcess.mjs';
const [checkoutArg, configArg, mode = '--plan'] = process.argv.slice(2);
if (!checkoutArg || !configArg || !['--plan', '--apply-local'].includes(mode))
  throw new Error('Usage: install.mjs <editor-data checkout> <config.json> [--plan|--apply-local]');
const checkout = resolve(checkoutArg);
const git = (...args) =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer }).trim();
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
const installedPinPath = join(checkout, '.publisher/PIN');
if (existsSync(installedPinPath)) {
  const installed = JSON.parse(readFileSync(installedPinPath, 'utf8'));
  if (
    !Array.isArray(installed.capabilities) ||
    installed.capabilities.some((capability) => !pin.capabilities.includes(capability))
  )
    throw new Error('Publisher install cannot drop installed capability floors');
}
const config = JSON.parse(readFileSync(resolve(configArg)));
// The installed pipeline publishes for real exactly when config.publishWritesEnabled is true
// (pipeline.yml picks --pipeline-publish). Refuse that config for a build whose baked switch
// (config/publisher.json at the PIN source) is OFF: it would throw on every run instead.
const runtime = readFileSync(join(template, '.publisher/publisher.mjs'), 'utf8');
const baked =
  /\/\/ config\/publisher\.json\r?\nvar publisher_default = \{\r?\n {2}enabled: (true|false)\r?\n\};/.exec(
    runtime,
  )?.[1];
if (baked === undefined) throw new Error('Runtime build switch not found');
if (typeof config.publishWritesEnabled !== 'boolean')
  throw new Error('config.publishWritesEnabled must be true or false');
if (config.publishWritesEnabled && baked !== 'true')
  throw new Error('publishWritesEnabled needs a build whose config/publisher.json is enabled');
const writes = config.publishWritesEnabled;
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
// Compute the Git blob identity from the SAME canonical bytes written below. The
// Worker observes it at the same head as this small installed-generator binding.
const configBytes = Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8');
const installed = {
  version: 1,
  configOid: createHash('sha1')
    .update(`blob ${configBytes.byteLength}\0`)
    .update(configBytes)
    .digest('hex'),
  generatorSha: config.generatorSha,
};
console.log(
  `Plan: retire bundle.yml; copy pipeline.yml and pinned .publisher; install public config and installed.json binding in the same commit. ${
    writes
      ? 'PUBLISH WRITES ENABLED: the pipeline runs --pipeline-publish and writes converter-v2-test.'
      : 'Publish transport remains dry-run.'
  } No commit/push.`,
);
if (mode === '--apply-local') {
  const dir = join(checkout, '.publisher');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(join(template, '.publisher')))
    if (f !== 'config.example.json') copyFileSync(join(template, '.publisher', f), join(dir, f));
  writeFileSync(join(dir, 'config.json'), configBytes);
  writeFileSync(join(dir, 'installed.json'), JSON.stringify(installed, null, 2) + '\n');
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
