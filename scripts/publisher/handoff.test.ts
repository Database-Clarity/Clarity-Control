import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalRepository } from './git.js';
import { paths } from './publisher.js';
import { pendingProductionHandoff } from './pipeline.js';

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
  const publisherSha = 'a'.repeat(40),
    generatorSha = 'b'.repeat(40),
    engine = 'c'.repeat(40);
  const source = repo.commit(
    undefined,
    {
      '.publisher/config.json': blob({ liveBranch: 'converter', publisherSha, generatorSha }),
      '.publisher/publisher.mjs': repo.writeBlob(runtime),
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
  expect(() => pendingProductionHandoff(f.repo)).toThrow('moved beyond its publication receipt');
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
