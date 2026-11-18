import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalRepository } from './git.js';
import { paths } from './publisher.js';
import { pendingProductionHandoff } from './pipeline.js';
import { Harness, fixturesDir, git } from '../../packages/export/test/site/harness.js';

vi.setConfig({ testTimeout: 120_000 });
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-identity-'));
  roots.push(root);
  const store = join(root, 'store.git');
  execFileSync('git', ['init', '--bare', store], { stdio: 'pipe' });
  execFileSync('git', ['--git-dir', store, 'config', 'publisher.simulator', 'true']);
  const repo = new LocalRepository(store);
  const blob = (value: unknown) => repo.writeBlob(JSON.stringify(value));
  const opId = '01K95H00000000000000000001';
  const runtime = '// verified fixture runtime\n';
  const verifier = readFileSync(
    'scripts/publisher/template/.publisher/verify-publication.mjs',
    'utf8',
  );
  const verifierSha256 = createHash('sha256').update(verifier).digest('hex');
  const publisherSha = 'a'.repeat(40),
    generatorSha = 'b'.repeat(40),
    engine = 'c'.repeat(40);
  const source = repo.commit(
    undefined,
    {
      '.publisher/config.json': blob({ liveBranch: 'converter', publisherSha, generatorSha }),
      '.publisher/publisher.mjs': repo.writeBlob(runtime),
      '.publisher/verify-publication.mjs': repo.writeBlob(verifier),
    },
    'Install fixture',
  );
  const receipt = {
    opId,
    sourceCommit: source,
    requestBlob: blob({ signed: 'fixture' }),
    generatorSha,
    publisherSha,
    now: 1,
    outcome: 'published',
    verifierSha256,
  };
  const commit = repo.commit(
    undefined,
    {
      '.exports/PIN': repo.writeBlob(engine + '\n'),
      '.exports/engine.mjs': repo.writeBlob('// engine\n'),
      'liveDescriptions.json': blob({ perks: {} }),
      [paths(opId).receipt]: blob(receipt),
    },
    'Publish fixture',
  );
  repo.cas('refs/heads/converter', undefined, commit);
  const record = repo.commit(
    source,
    {
      ...repo.tree(source),
      [paths(opId).log]: blob({ candidateCommit: commit, result: { status: 'done' } }),
    },
    'Record fixture',
  );
  repo.cas('refs/heads/editor-data', undefined, record);
  return { root, repo, commit, record, blob, engine, runtime };
}

it('reconciles a completed RECORD after a workflow crash and suppresses only matching built identities', () => {
  const f = fixture();
  const identity = pendingProductionHandoff(f.repo)!;
  expect(identity).toMatchObject({
    commit: f.commit,
    recordCommit: f.record,
    enginePin: f.engine,
    publisherDigest: createHash('sha256').update(f.runtime).digest('hex'),
  });
  const ref = 'refs/heads/export-pins';
  let parent: string | undefined;
  for (const field of ['inputSha256', 'engine', 'generatorSha', 'matching']) {
    const pin = {
      inputSha256: identity.inputSha256,
      engine: identity.enginePin,
      generatorSha: identity.generatorSha,
      ...(field === 'matching' ? {} : { [field]: '0'.repeat(64) }),
    };
    const next = f.repo.commit(parent, { 'pins/latest.json': f.blob(pin) }, 'Pin fixture');
    f.repo.cas(ref, parent, next);
    parent = next;
    expect(pendingProductionHandoff(f.repo)).toEqual(field === 'matching' ? undefined : identity);
  }
  // A forward rollback or another writer cannot be silently substituted for the receipt's input.
  const later = f.repo.commit(
    f.commit,
    { ...f.repo.tree(f.commit), marker: f.blob('later') },
    'Forward restore',
  );
  f.repo.cas('refs/heads/converter', f.commit, later);
  expect(pendingProductionHandoff(f.repo)).toBeUndefined();
});

it('verifies the exact site pin and rejects a concurrent deployment or altered promoted pin', () => {
  const f = fixture();
  const identity = pendingProductionHandoff(f.repo)!;
  const checkout = (name: string, commit: string) => {
    const dir = join(f.root, name);
    execFileSync('git', ['clone', '--no-checkout', f.repo.path, dir], { stdio: 'pipe' });
    execFileSync('git', ['-c', 'core.autocrlf=false', '-C', dir, 'checkout', commit], {
      stdio: 'pipe',
    });
    return dir;
  };
  const converter = checkout('converter', f.commit),
    producer = checkout('producer', f.record);
  const pinId = `${f.commit}-1-1`;
  const liveCommit = f.repo.commit(
    undefined,
    {},
    `Deploy fixture\n\nExport-Converter: ${f.commit}\nExport-Pin: ${pinId}\n`,
  );
  f.repo.cas('refs/heads/live', undefined, liveCommit);
  f.repo.git(['symbolic-ref', 'HEAD', 'refs/heads/live']);
  const pins = join(f.root, 'pins');
  mkdirSync(join(pins, 'pins'), { recursive: true });
  const pin = {
    converterSha: f.commit,
    inputSha256: identity.inputSha256,
    engine: f.engine,
    generatorSha: identity.generatorSha,
    pinId,
    liveCommit,
  };
  for (const file of ['latest', liveCommit])
    writeFileSync(join(pins, 'pins', file + '.json'), JSON.stringify(pin));
  const verify = () =>
    execFileSync(
      process.execPath,
      [
        'scripts/publisher/template/.publisher/verify-publication.mjs',
        converter,
        producer,
        pins,
        f.repo.path,
      ],
      {
        env: { ...process.env, PUBLICATION: JSON.stringify(identity) },
        stdio: 'pipe',
      },
    );
  expect(verify).not.toThrow();
  // Execute the actual workflow's trusted loader before any editor-data code.
  const workflow = readFileSync(
    'scripts/publisher/template/.github/workflows/build-outputs.yml',
    'utf8',
  );
  const loader = workflow
    .split("node --input-type=module <<'NODE'")[2]
    .split('\n          NODE')[0]
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  const loaderFile = join(f.root, 'loader.mjs');
  writeFileSync(loaderFile, loader);
  const load = () =>
    execFileSync(process.execPath, [loaderFile], {
      cwd: f.root,
      env: { ...process.env, PUBLICATION: JSON.stringify(identity), PROOF: producer },
      stdio: 'pipe',
    });
  expect(load).not.toThrow();
  const script = join(producer, '.publisher/verify-publication.mjs');
  const original = readFileSync(script);
  writeFileSync(script, '// tampered executable\n');
  expect(load).toThrow();
  writeFileSync(script, original);
  writeFileSync(
    join(pins, 'pins', liveCommit + '.json'),
    JSON.stringify({ ...pin, engine: 'd'.repeat(40) }),
  );
  expect(verify).toThrow();
  writeFileSync(join(pins, 'pins', liveCommit + '.json'), JSON.stringify(pin));
  const later = f.repo.commit(
    liveCommit,
    {},
    `Deploy fixture\n\nExport-Converter: ${'e'.repeat(40)}\nExport-Pin: ${pinId}\n`,
  );
  f.repo.cas('refs/heads/live', liveCommit, later);
  expect(verify).toThrow();
});

it('publication and failed-job retry retain interleaved config additions, edits, and deletions', async () => {
  // Match Actions' LF checkouts, including the snapshot hashes the real site builder verifies.
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.autocrlf');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'false');
  const h = new Harness();
  const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const project = (id: string, name = id.toUpperCase()) => ({
    schema: 1,
    id,
    name,
    files: [{ id: 'dim', uid: `${id}000001`, formatVersion: 1, preset: 'dim' }],
  });
  try {
    await h.seed({
      input: readFileSync(join(fixturesDir, 'legacy-input.json'), 'utf8'),
      projects: { alpha: project('alpha') },
    });
    const publisherSha = 'a'.repeat(40),
      enginePin = 'c'.repeat(40),
      runtime = '// runtime fixture\n';
    const verifier = readFileSync(
      'scripts/publisher/template/.publisher/verify-publication.mjs',
      'utf8',
    );
    const verifierSha256 = hash(verifier);
    const sourceCommit = h.commit('editor-data', {
      '.publisher/config.json': JSON.stringify({
        liveBranch: 'converter',
        publisherSha,
        generatorSha: h.generatorSha,
      }),
      '.publisher/publisher.mjs': runtime,
      '.publisher/verify-publication.mjs': verifier,
    });
    const opId = '01K95H00000000000000000001',
      receiptPath = paths(opId).receipt;
    const receipt = {
      opId,
      sourceCommit,
      requestBlob: 'd'.repeat(40),
      generatorSha: h.generatorSha,
      publisherSha,
      now: 1,
      outcome: 'published',
      verifierSha256,
    };
    const commit = h.commit('converter', {
      '.exports/PIN': enginePin + '\n',
      [receiptPath]: JSON.stringify(receipt),
    });
    const recordCommit = h.commit('editor-data', {
      [paths(opId).log]: JSON.stringify({ candidateCommit: commit, result: { status: 'done' } }),
    });
    const legacy = h.legacyRun();
    expect(legacy.status, legacy.stderr).toBe(0);
    const converter = h.checkout('converter'),
      producer = h.checkout('editor-data');
    git(producer, ['checkout', '--detach', recordCommit]);
    const identity = {
      ...receipt,
      commit,
      recordCommit,
      receiptPath,
      receiptBlob: git(converter, ['rev-parse', `HEAD:${receiptPath}`]),
      inputBlob: git(converter, ['rev-parse', 'HEAD:liveDescriptions.json']),
      inputSha256: hash(h.show(commit, 'liveDescriptions.json')!),
      enginePin,
      engineSha256: hash(h.show(commit, '.exports/engine.mjs')!),
      publisherDigest: hash(runtime),
    };
    const workflow = readFileSync(
      'scripts/publisher/template/.github/workflows/build-outputs.yml',
      'utf8',
    ).replaceAll('\r\n', '\n');
    const site = workflow.slice(workflow.indexOf('\n  site:\n'));
    expect(site).toMatch(/ref: editor-data\n {10}path: editor-data\n {10}sparse-checkout: exports/);
    expect(site).toContain('ref: ${{ needs.handoff.outputs.record }}');
    expect(site).toContain(
      'node producer/.publisher/verify-publication.mjs converter producer pins live',
    );
    const changes: Record<string, string | null>[] = [
      { 'exports/projects/beta.json': JSON.stringify(project('beta')) },
      { 'exports/projects/beta.json': JSON.stringify(project('beta', 'Edited beta')) },
      { 'exports/projects/alpha.json': null },
    ];
    for (const [round, files] of changes.entries()) {
      h.commit('editor-data', files);
      // The independent config-only job deploys before publication, or its failed-job retry.
      const configSite = h.siteRun();
      expect(configSite.status, configSite.stderr).toBe(0);
      const beta = h.served('beta/index.json');
      const alpha = h.served('alpha/index.json');
      expect(beta).toBeDefined();
      expect(h.servedJson('beta/index.json').name).toBe(round ? 'Edited beta' : 'BETA');
      if (round === 2) expect(alpha).toBeUndefined();
      const verified = h.node(
        resolve('scripts/publisher/template/.publisher/verify-publication.mjs'),
        [converter, producer, h.checkout('export-pins'), h.checkout('live')],
        { PUBLICATION: JSON.stringify(identity) },
      );
      expect(verified.status, verified.stderr).toBe(0);
      // The proof remains R, but site configs are read at job start under the data-site slot.
      const currentConfigs = h.checkout('editor-data');
      const publicationSite = h.siteRun({
        extra: ['--converter', converter, '--exports', join(currentConfigs, 'exports')],
      });
      expect(publicationSite.status, publicationSite.stderr).toBe(0);
      expect(h.served('beta/index.json')).toEqual(beta);
      expect(h.served('alpha/index.json')).toEqual(alpha);
      expect(git(producer, ['rev-parse', 'HEAD'])).toBe(recordCommit);
    }
    // A newer data/config-only site job queued behind an old publication must
    // survive the old job's green no-op (both groups retain pending jobs).
    expect(site).toContain('group: data-site\n      cancel-in-progress: false\n      queue: max');
    h.commit('converter', { 'liveDescriptions.json': h.show(commit, 'liveDescriptions.json')! });
    expect(h.legacyRun().status).toBe(0);
    h.commit('editor-data', { 'exports/projects/gamma.json': JSON.stringify(project('gamma')) });
    const output = join(h.root, 'old-site-output');
    const older = h.node(
      resolve('scripts/publisher/template/.publisher/verify-publication.mjs'),
      [converter, producer, h.checkout('export-pins'), h.checkout('live')],
      { PUBLICATION: JSON.stringify(identity), GITHUB_OUTPUT: output },
    );
    expect(older.status, older.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('build=false');
    const pendingConfig = h.siteRun();
    expect(pendingConfig.status, pendingConfig.stderr).toBe(0);
    expect(h.served('gamma/index.json')).toBeDefined();
  } finally {
    h.cleanup();
    vi.unstubAllEnvs();
  }
}, 300_000);
