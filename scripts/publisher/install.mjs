import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
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
  !['--plan', '--apply-local', '--verify'].includes(mode) ||
  (targetArg !== undefined && targetArg !== `--target=${plan}`) ||
  !Object.hasOwn(plans, plan) ||
  extra.length
)
  throw new Error(
    'Usage: install.mjs <editor-data checkout> <config.json> [--plan|--apply-local|--verify] [--target=test|--target=production]',
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
const pipelinePath = '.github/workflows/pipeline.yml';
const runPath = '.github/workflows/publisher-run.yml';
const runCall = /^\s*uses:\s*(['"]?)\.\/\.github\/workflows\/publisher-run\.yml\1\s*(?:#.*)?$/m;
const headFiles = new Map(
  git(
    'ls-tree',
    '-r',
    '--format=%(path)%x09%(objectname)',
    'HEAD',
    '--',
    '.publisher',
    '.github/workflows',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')),
);
const readBlob = (oid) =>
  execFileSync('git', ['-C', checkout, 'cat-file', 'blob', oid], { maxBuffer });
const callerOid = headFiles.get(pipelinePath);
const installedCaller = callerOid ? readBlob(callerOid).toString('utf8') : '';
// A legacy inline pipeline is a valid starting point. A split pipeline requires both files.
if (runCall.test(installedCaller) !== headFiles.has(runPath))
  throw new Error('Incomplete publisher workflow pair at HEAD');
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
// (publisher-run.yml picks --pipeline-publish). Refuse that config for a build whose baked switch
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
const blobOid = (bytes) =>
  createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
const installed = {
  version: 1,
  configOid: blobOid(configBytes),
  generatorSha: config.generatorSha,
};
if (mode !== '--verify')
  (mode === '--plan' ? console.error : console.log)(
    `Plan: retire bundle.yml and install pipeline.yml, publisher-run.yml, and pinned .publisher in one commit. ${
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
const downstream =
  plan === 'production'
    ? '\n' +
      readFileSync(join(template, 'production-job.yml'), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => '  ' + line)
        .join('\n') +
      '\n'
    : '';
const caller = readFileSync(join(template, pipelinePath), 'utf8');
const secretMarker =
  '    # Production output secrets are inherited only in the production install.';
if (!runCall.test(caller) || !caller.includes(secretMarker))
  throw new Error('Invalid publisher workflow caller template');
files.set(
  pipelinePath,
  Buffer.from(
    plan === 'production' ? caller.replace(secretMarker, '    secrets: inherit') : caller,
  ),
);
files.set(runPath, Buffer.from(readFileSync(join(template, runPath), 'utf8') + downstream));
files.set('.github/workflows/bundle.yml', null);
for (const [file, bytes] of files)
  if (bytes?.includes(13)) throw new Error(`Template must use LF bytes: ${file}`);
if (plan === 'production') {
  // actionlint 1.7.12 predates queue:max. Parse YAML with the existing project
  // parser and validate the exact supported queue policy from GitHub's schema.
  const reusable = readFileSync(join(template, '.github/workflows/build-outputs.yml'), 'utf8');
  const { format } = await import('prettier');
  for (const text of [
    reusable,
    files.get(pipelinePath).toString('utf8'),
    files.get(runPath).toString('utf8'),
  ])
    await format(text, { parser: 'yaml' });
  for (const [job, group] of [
    ['legacy', 'legacy-outputs'],
    ['site', 'data-site'],
  ]) {
    const body = reusable.split(`\n  ${job}:\n`)[1]?.split('\n    steps:')[0];
    if (
      !body?.includes(
        `concurrency:\n      group: ${group}\n      cancel-in-progress: false\n      queue: max`,
      )
    )
      throw new Error(
        `Unsupported ${group} queue policy; require queue:max and cancel-in-progress:false`,
      );
  }
}
if (mode === '--verify') {
  for (const [file, bytes] of files) {
    const expected = bytes === null ? undefined : blobOid(bytes);
    if (headFiles.get(file) !== expected)
      throw new Error(`Unexpected installed file at HEAD: ${file}`);
  }
  console.log(`Verified ${plan} publisher workflows and runtime at HEAD.`);
}
if (mode === '--plan') {
  const scratch = mkdtempSync(join(tmpdir(), 'publisher-install-plan-'));
  try {
    for (const side of ['a', 'b']) mkdirSync(join(scratch, side));
    for (const [file, bytes] of files) {
      const oid = headFiles.get(file);
      if (oid) {
        mkdirSync(dirname(join(scratch, 'a', file)), { recursive: true });
        writeFileSync(join(scratch, 'a', file), readBlob(oid));
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
