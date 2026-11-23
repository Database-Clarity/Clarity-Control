import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalRepository, RefRace, type Repository } from './git.js';
import { RemoteRepository, TransportUnresolved } from './remote.js';
vi.setConfig({ testTimeout: 60_000 });
const roots: string[] = [];
function bare() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-contract-'));
  roots.push(dir);
  execFileSync('git', ['init', '--bare', dir], { stdio: 'pipe' });
  execFileSync('git', ['--git-dir', dir, 'config', 'publisher.simulator', 'true']);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  // A killed Git client can leave receive-pack finishing its hook on Windows.
  await new Promise((resolve) => setTimeout(resolve, 3200));
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const data = 'refs/heads/editor-data';
const candidate = 'refs/heads/publish-candidate/01K95H00000000000000000001';
it('allowlisted publication plans grant only their selected target, including atomic writes', () => {
  for (const liveBranch of ['converter-v2-test', 'converter'] as const) {
    const repo = new RemoteRepository(bare(), { fileUrl: pathToFileURL(bare()).href, liveBranch });
    const live = `refs/heads/${liveBranch}`;
    const other = `refs/heads/${liveBranch === 'converter' ? 'converter-v2-test' : 'converter'}`;
    expect(() => repo.head(other)).toThrow('outside publisher scope');
    expect(() => repo.head('refs/heads/live')).toThrow('outside publisher scope');
    const a = repo.commit(undefined, { input: repo.writeBlob('old') }, 'Base');
    const b = repo.commit(a, { input: repo.writeBlob('new') }, 'Advance');
    repo.cas(data, undefined, a);
    repo.cas(live, undefined, a);
    repo.casMany([
      { ref: data, old: a, next: b },
      { ref: live, old: a, next: b },
    ]);
    expect(repo.head(data)).toBe(b);
    expect(repo.head(live)).toBe(b);
    expect(() =>
      repo.casMany([
        { ref: data, old: b, next: a },
        { ref: live, old: b, next: a },
      ]),
    ).toThrow('advance both branches');
  }
});
it('simulator and real file:// Git implement the same publication CAS contract', () => {
  const run = (repo: Repository) => {
    const blob = repo.writeBlob('exact bytes\n');
    const a = repo.commit(undefined, { file: blob }, 'base');
    repo.cas(data, undefined, a);
    const b = repo.commit(a, { file: blob, receipt: repo.writeBlob('receipt') }, 'publish');
    repo.cas(candidate, undefined, b);
    expect(() => repo.cas(candidate, undefined, a)).toThrow(RefRace);
    const c = repo.commit(a, { file: blob, receipt: repo.writeBlob('rebased') }, 'rebase');
    repo.cas(candidate, b, c);
    expect(() => repo.cas(candidate, b, a)).toThrow(RefRace);
    repo.cas(data, a, c);
    expect(() => repo.cas(data, a, b)).toThrow(RefRace);
    repo.cas(candidate, c, undefined);
    return {
      tree: repo.tree(repo.head(data)!),
      bytes: repo.blob(blob),
      candidateDeleted: repo.head(candidate) === undefined,
      ancestor: repo.ancestor(a, repo.head(data)!),
      additions: repo.additions(repo.head(data)!, 'receipt').map((e) => e.path),
    };
  };
  const simulator = new LocalRepository(bare());
  const remote = new RemoteRepository(bare(), { fileUrl: pathToFileURL(bare()).href });
  expect(run(remote)).toEqual(run(simulator));
});
it('preserves complete Git paths and their modes when reading a tree', () => {
  const repo = new RemoteRepository(bare(), { fileUrl: pathToFileURL(bare()).href });
  const oid = repo.git(['hash-object', '-w', '--stdin'], 'test data').trim();
  const filename = 'sample\tfilename';
  const tree = repo.git(['mktree', '-z'], `100755 blob ${oid}\t${filename}\0`).trim();
  const commit = repo.git(['commit-tree', tree], 'Example tree').trim();
  expect(repo.tree(commit)).toEqual({ [filename]: oid });
  expect(repo.treeModes(commit)).toEqual({ [filename]: '100755' });
});
it('local Git reads return real-size output beyond the 1 MiB child-process default', () => {
  // Phase B run 1 hit "spawnSync git ENOBUFS" on the real data repo; fixtures were too small.
  const repo = new LocalRepository(bare());
  const bytes = 'x'.repeat(2 << 20);
  const oid = repo.writeBlob(bytes);
  const tree = Object.fromEntries(
    Array.from({ length: 6000 }, (_, i) => [`items/${'p'.repeat(200)}-${i}.json`, oid]),
  );
  const head = repo.commit(undefined, tree, 'large');
  const fresh = new LocalRepository(repo.path);
  expect(fresh.blob(oid)).toBe(bytes);
  expect(fresh.tree(head)).toEqual(tree);
  expect(fresh.additions(head, 'items')).toHaveLength(6000);
});
/** Every Git command a repository starts, in order. */
class CountingRepository extends LocalRepository {
  commands: string[] = [];
  protected override gitBytes(...args: Parameters<LocalRepository['gitBytes']>) {
    this.commands?.push(args[0][0]);
    return super.gitBytes(...args);
  }
}
const bulk = (count: number, text: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => [`tooltips/${i}.json`, text(i)] as const);
it('bulk documents use one Git process to write and one to read, byte for byte', () => {
  const writer = new CountingRepository(bare());
  const documents = [
    ...bulk(400, (i) => `{"hash":${i}}\n`),
    ['tooltips/empty.json', ''],
    ['tooltips/bytes.json', 'CRLF\r\nNUL\0 \u00e9\u{1f600} \ufeffdone\nblob\ndata 3\n'],
    ['globals/large.json', 'x'.repeat(2 << 20)],
    ['config/plain.json', 'not bulk'],
  ] as const;
  writer.commands = [];
  const tree = Object.fromEntries(documents.map(([path, text]) => [path, writer.writeBlob(text)]));
  const head = writer.commit(undefined, tree, 'bulk');
  expect(writer.commands).toEqual([
    'fast-import',
    'read-tree',
    'update-index',
    'write-tree',
    'commit-tree',
  ]);
  for (const [path, text] of documents.slice(-6))
    expect(writer.git(['hash-object', '--stdin'], text).trim()).toBe(tree[path]);
  writer.commands = [];
  writer.commit(head, { ...tree, again: writer.writeBlob('{"hash":1}\n') }, 'unchanged bytes');
  expect(writer.commands).not.toContain('fast-import');

  const reader = new CountingRepository(writer.path);
  reader.commands = [];
  expect(reader.tree(head)).toEqual(tree);
  expect(documents.map(([path]) => reader.blob(tree[path]))).toEqual(
    documents.map(([, text]) => text),
  );
  expect(reader.commands).toEqual(['ls-tree', 'cat-file', 'cat-file']);
  expect(writer.git(['fsck', '--strict', '--no-dangling'])).toBe('');
});
it('batched reads decode invalid UTF-8 exactly like a single read', () => {
  const repo = new LocalRepository(bare());
  const oid = execFileSync('git', ['--git-dir', repo.path, 'hash-object', '-w', '--stdin'], {
    input: Buffer.from([0x22, 0xff, 0xc3, 0x28, 0x0a, 0x22]),
  })
    .toString()
    .trim();
  const commit = (path: string) => {
    const env = { GIT_INDEX_FILE: join(bare(), 'index') };
    repo.git(['update-index', '-z', '--index-info'], `100644 ${oid}\t${path}\0`, env);
    return repo
      .git(['commit-tree', repo.git(['write-tree'], undefined, env).trim()], 'bytes')
      .trim();
  };
  const batched = new LocalRepository(repo.path),
    single = new LocalRepository(repo.path);
  batched.tree(commit('tooltips/1.json'));
  single.tree(commit('other/1.json'));
  expect(batched.blob(oid)).toBe(single.blob(oid));
});
it('a missing object or a non-blob fails when it is read, exactly as a single read does', () => {
  const repo = new LocalRepository(bare());
  const head = repo.commit(
    undefined,
    Object.fromEntries(bulk(20, (i) => `doc ${i}`).map(([p, text]) => [p, repo.writeBlob(text)])),
    'base',
  );
  const tree = repo.tree(head);
  const gone = 'f'.repeat(40);
  const subtree = repo.git(['rev-parse', `${head}:tooltips`]).trim();
  const listing = Object.entries(tree).map(([path, oid]) => `100644 blob ${oid}\t${path}\0`);
  for (const bad of [gone, subtree]) {
    class Damaged extends LocalRepository {
      override git(...args: Parameters<LocalRepository['git']>) {
        return args[0][0] === 'ls-tree'
          ? [`100644 blob ${bad}\ttooltips/bad.json\0`, ...listing].join('')
          : super.git(...args);
      }
    }
    const damaged = new Damaged(repo.path);
    expect(damaged.tree(head)['tooltips/bad.json']).toBe(bad);
    expect(damaged.blob(tree['tooltips/7.json'])).toBe('doc 7');
    expect(() => damaged.blob(bad)).toThrow();
  }
});
it.each(['cut', 'renamed', 'extra', 'failed'])('a %s batch read yields no bytes', (fault) => {
  const repo = new LocalRepository(bare());
  const head = repo.commit(
    undefined,
    Object.fromEntries(bulk(3, (i) => `doc ${i}`).map(([p, text]) => [p, repo.writeBlob(text)])),
    'base',
  );
  class Faulty extends LocalRepository {
    protected override gitBytes(...args: Parameters<LocalRepository['gitBytes']>) {
      const output = super.gitBytes(...args);
      if (!args[0].includes('--batch')) return output;
      if (fault === 'failed') throw new Error('cat-file died');
      if (fault === 'cut') return output.subarray(0, output.length - 4);
      if (fault === 'extra') return Buffer.concat([output, Buffer.from('more\n')]);
      return Buffer.from(output.toString().replace(/^.{40}/, '0'.repeat(40)));
    }
  }
  expect(() => new Faulty(repo.path).tree(head)).toThrow(
    fault === 'failed' ? 'cat-file died' : 'Unexpected Git batch output',
  );
});
it('a failed or partial blob import commits nothing and can be retried', () => {
  let fault: 'dies' | 'skips' | undefined = 'dies';
  class Faulty extends LocalRepository {
    protected override gitBytes(...args: Parameters<LocalRepository['gitBytes']>) {
      if (args[0][0] === 'fast-import' && fault === 'dies') throw new Error('fast-import died');
      if (args[0][0] === 'fast-import' && fault === 'skips') return Buffer.alloc(0);
      return super.gitBytes(...args);
    }
  }
  const repo = new Faulty(bare());
  const tree = { 'tooltips/1.json': repo.writeBlob('one') };
  expect(() => repo.commit(undefined, tree, 'dies')).toThrow('fast-import died');
  expect(repo.git(['count-objects']).trim()).toMatch(/^0 objects/);
  fault = undefined;
  const head = repo.commit(undefined, tree, 'retry');
  expect(new LocalRepository(repo.path).blob(tree['tooltips/1.json'])).toBe('one');
  fault = 'skips';
  expect(() =>
    repo.commit(head, { ...tree, 'tooltips/2.json': repo.writeBlob('two') }, 'skips'),
  ).toThrow(/invalid object|write-tree/);
  expect(repo.git(['for-each-ref'])).toBe('');
});
it('real receive-pack timeout remains unresolved and can reconcile the exact commit', async () => {
  const upstream = bare();
  class PushTimeoutRepository extends RemoteRepository {
    timeoutPush = true;
    override remoteGit(args: string[]) {
      this.commandTimeout = args[0] === 'push' && this.timeoutPush ? 1000 : 120_000;
      try {
        return super.remoteGit(args);
      } finally {
        this.commandTimeout = 120_000;
      }
    }
  }
  const repo = new PushTimeoutRepository(bare(), {
    fileUrl: pathToFileURL(upstream).href,
  });
  const a = repo.commit(undefined, { file: repo.writeBlob('bytes') }, 'base');
  const hook = join(upstream, 'hooks', 'pre-receive');
  const finished = hook + '.finished';
  const accept = hook + '.accept';
  // Keep this script immutable: a shell can read it incrementally after the client is killed.
  // Each invocation chooses its outcome before sleeping, so the first always rejects even
  // if the retry is enabled before that shell actually exits.
  writeFileSync(
    hook,
    '#!/bin/sh\nif [ -f "$0.accept" ]; then\n  exit 0\nfi\nsleep 3\ntouch "$0.finished"\nexit 1\n',
  );
  chmodSync(hook, 0o755);
  expect(() => repo.cas(data, undefined, a)).toThrow(TransportUnresolved);
  // The marker establishes that the old invocation selected rejection; it need not have exited.
  const deadline = Date.now() + 20_000;
  while (!existsSync(finished)) {
    if (Date.now() > deadline) throw new Error('Timed-out receive hook did not finish');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // No success inferred from absent ref; retry uses the exact original commit.
  writeFileSync(accept, '');
  repo.timeoutPush = false;
  repo.cas(data, undefined, a);
  expect(repo.head(data)).toBe(a);
});
it('GitHub credentials travel only through process env and errors are redacted', () => {
  const token = 'test-secret-token';
  const repo = new RemoteRepository(bare(), {
    repo: 'Database-Clarity/Live-Clarity-Database',
    token,
  });
  const git = vi.spyOn(repo, 'git').mockImplementation(() => {
    throw new Error(token);
  });
  expect(() =>
    repo.remoteGit(['ls-remote', 'https://github.com/Database-Clarity/Live-Clarity-Database.git']),
  ).toThrow('Remote Git outcome unresolved');
  const [args, , env] = git.mock.calls[0];
  expect(JSON.stringify(args)).not.toContain(token);
  expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2' });
});
it('a missing per-ref acknowledgement cannot be treated as success', () => {
  const repo = new RemoteRepository(bare(), { fileUrl: pathToFileURL(bare()).href });
  const commit = repo.commit(undefined, { file: repo.writeBlob('bytes') }, 'candidate');
  const remoteGit = repo.remoteGit.bind(repo);
  vi.spyOn(repo, 'remoteGit').mockImplementation((args) =>
    args[0] === 'push' ? '' : remoteGit(args),
  );
  expect(() => repo.cas(candidate, undefined, commit)).toThrow(TransportUnresolved);
  expect(repo.head(candidate)).toBeUndefined();
});
