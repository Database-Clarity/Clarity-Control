import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalRepository } from './git.js';
import { Publisher, type Options } from './publisher.js';

export type PipelineConfig = Omit<Options, 'now' | 'backoff' | 'publicKey'> & {
  keyEndpoint: string;
};
const bundleRef = 'refs/heads/editor-data-bundle';
const gitAt = (cwd: string, args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });

export function simulationArtifact(repo: LocalRepository, out: string, bases: string[]) {
  const revisions = ['--branches', '--not', ...bases];
  const count = Number(gitAt(repo.path, ['rev-list', '--count', ...revisions]).trim());
  if (count)
    gitAt(repo.path, ['bundle', 'create', join(out, 'would-be-commits.bundle'), ...revisions]);
  writeFileSync(
    join(out, 'would-be-commits.json'),
    JSON.stringify(
      { commits: count, bundle: count ? 'would-be-commits.bundle' : null, prerequisites: bases },
      null,
      2,
    ) + '\n',
  );
}

/** The ONLY remote write in this transport is the fixed bundle ref. Publishing stays local. */
export async function runPipeline(checkout: string, config: PipelineConfig, output: string) {
  if (
    config.repo !== 'Database-Clarity/Live-Clarity-Database' ||
    config.dataBranch !== 'editor-data' ||
    config.liveBranch !== 'converter-v2-test'
  )
    throw new Error('Pipeline target is not the held test target');
  const cwd = resolve(checkout),
    out = resolve(output);
  mkdirSync(out, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), 'publisher-pipeline-'));
  let failure: unknown;
  const reports: unknown[] = [];
  function snapshot(label: string) {
    // Always latest heads after acquiring the workflow slot, never the event checkout.
    gitAt(cwd, ['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
    const repo = join(temp, label + '.git');
    gitAt(cwd, ['clone', '--bare', '--no-hardlinks', '--', cwd, repo]);
    const command = (args: string[]) => gitAt(repo, args);
    command(['remote', 'remove', 'origin']);
    command(['config', 'publisher.simulator', 'true']);
    const refs = gitAt(cwd, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/remotes/origin/',
    ]);
    for (const line of refs.trim().split('\n')) {
      const [ref, oid] = line.split(' ');
      if (ref.endsWith('/HEAD')) continue;
      command(['update-ref', ref.replace('refs/remotes/origin/', 'refs/heads/'), oid]);
    }
    // clone --bare copies local heads, too: remove any stale candidate/bundle refs absent remotely.
    const remoteNames = new Set(
      refs.split('\n').map((l) => l.split(' ')[0].replace('refs/remotes/origin/', 'refs/heads/')),
    );
    for (const ref of command(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
      .trim()
      .split('\n'))
      if (ref && !remoteNames.has(ref)) command(['update-ref', '-d', ref]);
    return new LocalRepository(repo);
  }
  function publishBundle(repo: LocalRepository, options: Options) {
    const pub = new Publisher(repo, options),
      old = repo.head(bundleRef);
    pub.bundle();
    const next = repo.head(bundleRef)!;
    if (next !== old) {
      gitAt(cwd, ['fetch', '--no-tags', repo.path, `+${bundleRef}:refs/publisher/bundle`]);
      // Explicit lease, including the create-only empty old value. No data/live/candidate pushes.
      gitAt(cwd, [
        'push',
        `--force-with-lease=${bundleRef}:${old ?? ''}`,
        'origin',
        `${next}:${bundleRef}`,
      ]);
    }
    const queue = pub.queue(pub.head(options.dataBranch));
    reports.push({
      sourceCommit: pub.head(options.dataBranch),
      bundleCommit: next,
      pending: queue.length,
      recovery: queue.length
        ? 'Pending work: authorized client kick after 3 minutes or maintainer Retry; any save restarts catch-up.'
        : null,
    });
  }
  // Bundling must work even if key acquisition or the simulated drain fails.
  const options: Options = { ...config, publicKey: '', now: Date.now };
  try {
    const initial = snapshot('initial');
    publishBundle(initial, options);
    const bases = gitAt(initial.path, ['for-each-ref', '--format=%(objectname)', 'refs/heads/'])
      .trim()
      .split('\n');
    try {
      const endpoint = new URL(config.keyEndpoint);
      if (endpoint.protocol !== 'https:') throw new Error('HTTPS Worker key endpoint required');
      const response = await fetch(endpoint, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Worker key unavailable');
      const key = (await response.json()) as {
        algorithm: string;
        publicKey: string;
        fingerprint: string;
      };
      const fingerprint = createHash('sha256')
        .update(createPublicKey(key.publicKey).export({ type: 'spki', format: 'der' }))
        .digest('hex');
      if (
        key.algorithm !== 'Ed25519' ||
        fingerprint !== config.keyFingerprint ||
        key.fingerprint !== fingerprint
      )
        throw new Error('Worker key fingerprint mismatch');
      options.publicKey = key.publicKey;
      await new Publisher(initial, options).run();
    } catch (e) {
      failure = e;
    }
    simulationArtifact(initial, out, bases);
  } catch (e) {
    failure = e;
  } finally {
    try {
      // Bounded catch-up pass; repairs failed/empty drains from real data, never simulated RECORDs.
      publishBundle(snapshot('catch-up'), options);
    } catch (e) {
      failure ??= e;
    }
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify(
        {
          dryRun: true,
          publishWritesEnabled: false,
          reports,
          error: failure ? String(failure) : null,
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      join(out, 'summary.md'),
      `Publish writes are disabled. Bundles use real editor-data heads.\n\n` +
        'Catch-up watchdog: this run refreshes the bundle before simulation and again afterwards, even on drain failure.\n\n' +
        'Pending requests stay durable. The client may kick once after 3 minutes; maintainers/editors can use Retry. Any save also starts catch-up. An unattended cron watchdog is held for Phase 3.\n\n' +
        '```json\n' +
        JSON.stringify(reports, null, 2) +
        '\n```\n',
    );
    rmSync(temp, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

export function verifyRuntime(root: string) {
  const pin = JSON.parse(readFileSync(join(root, 'PIN'), 'utf8'));
  if (
    !/^[0-9a-f]{40}$/.test(pin.sourceSha) ||
    createHash('sha256')
      .update(readFileSync(join(root, 'publisher.mjs')))
      .digest('hex') !== pin.sha256
  )
    throw new Error('Publisher PIN mismatch');
  return pin as { sourceSha: string; sha256: string };
}
