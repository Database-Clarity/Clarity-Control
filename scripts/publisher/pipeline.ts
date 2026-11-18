import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maxBuffer } from './childProcess.mjs';
import { LocalRepository } from './git.js';
import { RemoteRepository } from './remote.js';
import publisherConfig from '../../config/publisher.json';
import { Publisher, paths, type Receipt, type Options } from './publisher.js';
import { GlobalsPublisher } from './globals.js';
import { SchedulePreparer } from '../schedule-prepare/prepare.js';

export type PipelineConfig = Omit<Options, 'now' | 'backoff' | 'publicKey'> & {
  keyEndpoint: string;
  publishWritesEnabled?: boolean;
};
const bundleRef = 'refs/heads/editor-data-bundle';
const gitAt = (cwd: string, args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer,
  });

/** All identities come from the confirmed commit's tree, never a later branch head. */
export function publicationIdentity(
  repo: LocalRepository,
  landed: Publisher['publications'][number],
  publisherDigest: string,
  requireEngine = true,
) {
  const tree = repo.tree(landed.commit);
  const receiptPath = paths(landed.opId).receipt;
  const receiptBlob = tree[receiptPath];
  const receipt = JSON.parse(repo.blob(receiptBlob)) as Receipt;
  const enginePin = tree['.exports/PIN'] ? repo.blob(tree['.exports/PIN']).trim() : null;
  if (
    receipt.opId !== landed.opId ||
    (requireEngine &&
      (!enginePin || !/^[a-f0-9]{40}$/.test(enginePin) || !tree['.exports/engine.mjs'])) ||
    !/^[a-f0-9]{40}$/.test(receipt.generatorSha) ||
    !/^[a-f0-9]{64}$/.test(publisherDigest)
  )
    throw new Error('Invalid immutable publication identity');
  const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  return {
    ...landed,
    receiptPath,
    receiptBlob,
    sourceCommit: receipt.sourceCommit,
    requestBlob: receipt.requestBlob,
    inputBlob: tree['liveDescriptions.json'],
    inputSha256: hash(repo.blob(tree['liveDescriptions.json'])),
    enginePin,
    engineSha256: tree['.exports/engine.mjs'] ? hash(repo.blob(tree['.exports/engine.mjs'])) : null,
    generatorSha: receipt.generatorSha,
    publisherSha: receipt.publisherSha,
    publisherDigest,
    outcome: receipt.outcome,
  };
}

/** Recover a missed downstream job from durable receipts/RECORDs and export pins.
 * A successful RECORD must survive a workflow crash before its job outputs exist. */
export function pendingProductionHandoff(repo: LocalRepository) {
  const head = repo.head('refs/heads/converter')!;
  const added = repo.additions(head, '.publish/receipts').at(-1);
  if (!added) return;
  if (added.commit !== head)
    throw new Error('Production target moved beyond its publication receipt');
  const receipt = JSON.parse(repo.blob(repo.tree(head)[added.path])) as Receipt;
  const data = repo.head('refs/heads/editor-data')!;
  const record = repo.additions(data, paths(receipt.opId).log).at(-1);
  if (!record) throw new Error('Production receipt has no confirmed RECORD');
  const tree = repo.tree(record.commit);
  const log = JSON.parse(repo.blob(tree[paths(receipt.opId).log]));
  if (log.candidateCommit !== head || !['done', 'unchanged'].includes(log.result?.status))
    throw new Error('Production RECORD differs from receipt');
  const digest = createHash('sha256')
    .update(repo.blob(tree['.publisher/publisher.mjs']))
    .digest('hex');
  const identity = publicationIdentity(
    repo,
    { opId: receipt.opId, commit: head, recordCommit: record.commit },
    digest,
  );
  // Read the snapshot's export-pins without granting RemoteRepository write scope to it.
  const refs = repo
    .git(['for-each-ref', '--format=%(objectname)', 'refs/heads/export-pins'])
    .trim();
  const pinTree = refs ? repo.tree(refs) : {};
  const pin = pinTree['pins/latest.json']
    ? JSON.parse(repo.blob(pinTree['pins/latest.json']))
    : undefined;
  if (
    pin?.inputSha256 === identity.inputSha256 &&
    pin?.engine === identity.enginePin &&
    pin?.generatorSha === identity.generatorSha
  )
    return;
  return identity;
}

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

/** Explicit remote mode is gated by both the built config and the runtime config. */
export async function runPipeline(
  checkout: string,
  config: PipelineConfig,
  output: string,
  remoteMode = false,
) {
  if (
    config.repo !== 'Database-Clarity/Live-Clarity-Database' ||
    config.dataBranch !== 'editor-data' ||
    !['converter-v2-test', 'converter'].includes(config.liveBranch)
  )
    throw new Error('Pipeline target is not an allowlisted publication target');
  const enabled = remoteMode && publisherConfig.enabled && config.publishWritesEnabled === true;
  if (remoteMode && !enabled) throw new Error('Remote publishing disabled by config');
  if (enabled && !process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN required');
  const cwd = resolve(checkout),
    out = resolve(output);
  mkdirSync(out, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), 'publisher-pipeline-'));
  let failure: unknown;
  const reports: unknown[] = [];
  const publications: ReturnType<typeof publicationIdentity>[] = [];
  let handoff: ReturnType<typeof pendingProductionHandoff>;
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
    return enabled
      ? new RemoteRepository(repo, {
          repo: config.repo,
          token: process.env.GITHUB_TOKEN,
          liveBranch: config.liveBranch as 'converter-v2-test' | 'converter',
        })
      : new LocalRepository(repo);
  }
  function publishBundle(repo: LocalRepository, options: Options) {
    const pub = new Publisher(repo, options),
      old = repo.head(bundleRef);
    pub.bundle();
    const next = repo.head(bundleRef)!;
    if (next !== old && !(repo instanceof RemoteRepository)) {
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
      // Due work only: a scheduled batch before its notBefore is listed, never pending.
      pending: queue.length,
      scheduled: pub.scheduledQueue(pub.head(options.dataBranch)).length,
      recovery: queue.length
        ? 'Pending work: authorized client kick after 3 minutes or maintainer Retry; any save restarts catch-up.'
        : null,
    });
  }
  // Bundling must work even if key acquisition or the simulated drain fails.
  const options: Options = { ...config, publicKey: '', now: Date.now };
  try {
    const initial = snapshot('initial');
    if (config.liveBranch === 'converter') {
      const tree = initial.tree(initial.head('refs/heads/converter')!);
      if (
        !tree['.exports/PIN'] ||
        !/^[a-f0-9]{40}$/.test(initial.blob(tree['.exports/PIN']).trim()) ||
        !tree['.exports/engine.mjs']
      )
        throw new Error('Production target requires a pinned installed engine');
    }
    // In write mode, commit the coalesced materialization before the first public
    // bundle. Dry-run materialization remains in the disposable simulator below.
    if (!enabled) publishBundle(initial, options);
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
      const publisher = new Publisher(initial, options);
      // GITHUB_TOKEN commits do not trigger another workflow: prepare, globals, bundle,
      // and publication all happen in this serialized run, after reading latest heads.
      await new SchedulePreparer(publisher).drain();
      await new GlobalsPublisher(publisher).drain();
      if (enabled) publishBundle(initial, options);
      await publisher.run(false);
      if (enabled && publisher.publications.length) {
        // Do not hand off a candidate displaced by another writer during the drain.
        const last = publisher.publications.at(-1)!;
        if (initial.head(`refs/heads/${config.liveBranch}`) !== last.commit)
          throw new Error('Publication target moved before handoff');
        for (const landed of publisher.publications)
          publications.push(
            publicationIdentity(
              initial,
              landed,
              config.publisherDigest ?? '',
              config.liveBranch === 'converter',
            ),
          );
      }
    } catch (e) {
      failure = e;
    }
    if (!enabled) simulationArtifact(initial, out, bases);
  } catch (e) {
    failure = e;
  } finally {
    try {
      // Bounded catch-up bundle from real data, never simulated RECORDs.
      const latest = snapshot('catch-up');
      publishBundle(latest, options);
      if (enabled && config.liveBranch === 'converter' && !failure)
        handoff = pendingProductionHandoff(latest);
    } catch (e) {
      failure ??= e;
    }
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify(
        {
          dryRun: !enabled,
          publishWritesEnabled: enabled,
          reports,
          publications,
          handoff: handoff ?? null,
          error: failure ? String(failure) : null,
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      join(out, 'summary.md'),
      `Publish writes are ${enabled ? 'enabled' : 'disabled'}. Bundles use real editor-data heads.\n\n` +
        'Catch-up watchdog: this run refreshes the bundle before simulation and again afterwards, even on drain failure.\n\n' +
        'Pending requests stay durable. The client may kick once after 3 minutes; maintainers/editors can use Retry. Any save also starts catch-up. An unattended cron watchdog is held for Phase 3.\n\n' +
        '```json\n' +
        JSON.stringify(reports, null, 2) +
        '\n```\n',
    );
    rmSync(temp, { recursive: true, force: true });
  }
  if (failure) throw failure;
  // Emit only after LIVE, RECORD, and catch-up all succeeded. Failed/partial runs
  // retain diagnostics but cannot authorize downstream production jobs.
  const productionPush = handoff !== undefined;
  if (process.env.GITHUB_OUTPUT)
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `production_push=${productionPush}\npublication=${productionPush ? JSON.stringify(handoff) : ''}\n`,
      { flag: 'a' },
    );
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
  return pin as { sourceSha: string; sha256: string; capabilities?: string[] };
}
