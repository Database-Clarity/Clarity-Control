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
