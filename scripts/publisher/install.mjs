import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  readdirSync,
  mkdtempSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { maxBuffer } from './childProcess.mjs';
const [checkoutArg, configArg, mode = '--plan', targetArg, ...extra] = process.argv.slice(2);
const plans = { test: 'converter-v2-test', production: 'converter' };
const plan = targetArg?.replace(/^--target=/, '') ?? 'test';
if (
  !checkoutArg ||
  !configArg ||
  !['--plan', '--apply-local'].includes(mode) ||
  (targetArg !== undefined && targetArg !== `--target=${plan}`) ||
  !Object.hasOwn(plans, plan) ||
  extra.length
)
  throw new Error(
    'Usage: install.mjs <editor-data checkout> <config.json> [--plan|--apply-local] [--target=test|--target=production]',
  );
const liveBranch = plans[plan];
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
const installedConfig = join(checkout, '.publisher/config.json');
if (existsSync(installedConfig)) {
  const previous = JSON.parse(readFileSync(installedConfig, 'utf8'));
  if (previous.liveBranch !== liveBranch && !targetArg)
    throw new Error('Target switch requires an explicit --target plan');
}
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
  config.liveBranch !== liveBranch ||
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
      ? `PUBLISH WRITES ENABLED: the pipeline runs --pipeline-publish and writes ${liveBranch}.`
      : 'Publish transport remains dry-run.'
  } No commit/push.`,
);
// Both modes use exactly these bytes. --plan prints an applicable patch without
// changing the checkout, its index, its object store, or any remote ref.
const files = new Map();
for (const file of readdirSync(join(template, '.publisher')))
  if (file !== 'config.example.json')
    files.set(`.publisher/${file}`, readFileSync(join(template, '.publisher', file)));
files.set('.publisher/config.json', configBytes);
files.set('.publisher/installed.json', Buffer.from(JSON.stringify(installed, null, 2) + '\n'));
files.set(
  '.github/workflows/pipeline.yml',
  readFileSync(join(template, '.github/workflows/pipeline.yml')),
);
files.set('.github/workflows/bundle.yml', null);
if (mode === '--plan') {
  const scratch = mkdtempSync(join(tmpdir(), 'publisher-install-plan-'));
  try {
    for (const side of ['a', 'b']) mkdirSync(join(scratch, side));
    for (const [file, bytes] of files) {
      const current = join(checkout, file);
      if (existsSync(current)) {
        mkdirSync(dirname(join(scratch, 'a', file)), { recursive: true });
        copyFileSync(current, join(scratch, 'a', file));
      }
      if (bytes !== null) {
        mkdirSync(dirname(join(scratch, 'b', file)), { recursive: true });
        writeFileSync(join(scratch, 'b', file), bytes);
      }
    }
    const diff = spawnSync(
      'git',
      ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-prefix', '--', 'a', 'b'],
      {
        cwd: scratch,
        encoding: 'utf8',
        maxBuffer,
      },
    );
    if (![0, 1].includes(diff.status)) throw new Error('Cannot produce installation diff');
    process.stdout.write(diff.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (mode === '--apply-local') {
  for (const [file, bytes] of files) {
    const path = join(checkout, file);
    if (bytes === null) {
      if (existsSync(path)) rmSync(path);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  }
  console.log(
    'Local files prepared. Review git diff and run actionlint before an operator commits.',
  );
}
