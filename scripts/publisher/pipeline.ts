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
import { activeGlobalsFence } from './globalsInPlace.js';
import { SchedulePreparer } from '../schedule-prepare/prepare.js';
import { drainCurrentSaves } from './currentSave.js';

export type PipelineConfig = Omit<Options, 'now' | 'publicKey'> & {
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

/** One identity path for publication and crash recovery: confirmed Git receipts + RECORDs. */
export function publicationIdentity(repo: LocalRepository, branch = 'converter') {
  const commit = repo.head('refs/heads/' + branch)!;
  const added = repo.additions(commit, '.publish/receipts').at(-1);
  if (!added) return;
  if (added.commit !== commit) {
    console.log('Output handoff: non-publisher descendant; no publication handoff needed');
    return;
  }
  const tree = repo.tree(commit);
  const receipt = JSON.parse(repo.blob(tree[added.path])) as Receipt;
  const receiptPath = paths(receipt.opId).receipt;
  if (added.path !== receiptPath) throw new Error('Publication receipt path mismatch');
  const data = repo.head('refs/heads/editor-data')!;
  const record = repo.additions(data, paths(receipt.opId).log).at(-1);
  if (!record) throw new Error('Publication receipt has no confirmed RECORD');
  const recordTree = repo.tree(record.commit);
  const log = JSON.parse(repo.blob(recordTree[paths(receipt.opId).log]));
  if (log.candidateCommit !== commit || !['done', 'unchanged'].includes(log.result?.status))
    throw new Error('Publication RECORD differs from receipt');
  const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const enginePin = tree['.exports/PIN'] ? repo.blob(tree['.exports/PIN']).trim() : null;
  if (
    !/^[a-f0-9]{40}$/.test(receipt.generatorSha) ||
    (branch === 'converter' &&
      (!enginePin ||
        !/^[a-f0-9]{40}$/.test(enginePin) ||
        !tree['.exports/engine.mjs'] ||
        !receipt.verifierSha256 ||
        !/^[a-f0-9]{64}$/.test(receipt.verifierSha256) ||
        !recordTree['.publisher/verify-publication.mjs'] ||
        hash(repo.blob(recordTree['.publisher/verify-publication.mjs'])) !==
          receipt.verifierSha256))
  )
    throw new Error('Invalid immutable publication identity');
  return {
    opId: receipt.opId,
    commit,
    recordCommit: record.commit,
    receiptPath,
    receiptBlob: tree[receiptPath],
    sourceCommit: receipt.sourceCommit,
    requestBlob: receipt.requestBlob,
    inputBlob: tree['liveDescriptions.json'],
    inputSha256: hash(repo.blob(tree['liveDescriptions.json'])),
    enginePin,
    engineSha256: tree['.exports/engine.mjs'] ? hash(repo.blob(tree['.exports/engine.mjs'])) : null,
    generatorSha: receipt.generatorSha,
    publisherSha: receipt.publisherSha,
    publisherDigest: hash(repo.blob(recordTree['.publisher/publisher.mjs'])),
    verifierSha256: receipt.verifierSha256 ?? null,
    outcome: receipt.outcome,
  };
}

function needsOutputs(
  repo: LocalRepository,
  identity: NonNullable<ReturnType<typeof publicationIdentity>>,
) {
  // Read the snapshot's export pins without granting transport write scope to that branch.
  const refs = repo
    .git(['for-each-ref', '--format=%(objectname)', 'refs/heads/export-pins'])
    .trim();
  const tree = refs ? repo.tree(refs) : {};
  const pin = tree['pins/latest.json']
    ? JSON.parse(repo.blob(tree['pins/latest.json']))
    : undefined;
  return (
    pin?.inputSha256 !== identity.inputSha256 ||
    pin?.engine !== identity.enginePin ||
    pin?.generatorSha !== identity.generatorSha
  );
}

export function pendingProductionHandoff(repo: LocalRepository) {
  const identity = publicationIdentity(repo);
  return identity && needsOutputs(repo, identity) ? identity : undefined;
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
  let active = false;
  const reports: unknown[] = [];
  const publications: NonNullable<ReturnType<typeof publicationIdentity>>[] = [];
  let handoff: ReturnType<typeof pendingProductionHandoff>;
  function snapshot(label: string) {
    // Always latest heads after acquiring the workflow slot, never the event checkout.
    const shallow = gitAt(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
    // The workflow checks out only its runtime tip. Simulations and history guards
    // still need complete histories, including refs outside the publication write scope.
    gitAt(cwd, [
      'fetch',
      '--prune',
      '--no-tags',
      ...(shallow ? ['--unshallow'] : []),
      'origin',
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    if (shallow && gitAt(cwd, ['rev-parse', '--is-shallow-repository']).trim() !== 'false')
      throw new Error('Publisher snapshot requires complete Git history');
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
  async function publishBundle(repo: LocalRepository, options: Options, prepare = false) {
    const pub = new Publisher(repo, options);
    if (prepare) await pub.prepareBundle();
    let next: string;
    for (let attempt = 0; ; attempt++) {
      const old = repo.head(bundleRef);
      pub.bundle();
      next = repo.head(bundleRef)!;
      if (next === old || repo instanceof RemoteRepository) break;
      gitAt(cwd, ['fetch', '--no-tags', repo.path, `+${bundleRef}:refs/publisher/bundle`]);
      try {
        // Explicit lease, including the create-only empty old value. No data/live/candidate pushes.
        gitAt(cwd, [
          'push',
          `--force-with-lease=${bundleRef}:${old ?? ''}`,
          'origin',
          `${next}:${bundleRef}`,
        ]);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        // Refresh only the bundle base. The dry run continues simulating its original data snapshot.
        gitAt(cwd, ['fetch', '--no-tags', 'origin', `+${bundleRef}:refs/publisher/bundle-base`]);
        gitAt(repo.path, ['fetch', '--no-tags', cwd, 'refs/publisher/bundle-base']);
        const current = repo.git(['rev-parse', '--verify', 'FETCH_HEAD']).trim();
        if (current === old || (old && !repo.ancestor(old, current))) throw error;
        repo.cas(bundleRef, next, current);
      }
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
    const initialPublisher = new Publisher(initial, options);
    const initialTree = initial.tree(initialPublisher.head(options.dataBranch));
    active = Boolean(activeGlobalsFence(initialPublisher, initialTree));
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
    if (active && !enabled) await publishBundle(initial, options);
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
      // GITHUB_TOKEN commits do not trigger another workflow. Authored upkeep joins bundle
      // preparation before publication in the same serialized run.
      active =
        active &&
        Boolean(activeGlobalsFence(publisher, initial.tree(publisher.head(options.dataBranch))));
      if (active) {
        await drainCurrentSaves(publisher);
        await new SchedulePreparer(publisher).drain();
        if (enabled) await publishBundle(initial, options, true);
        else await publisher.prepareBundle();
        await publisher.run(false);
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
      if (active) {
        const latest = snapshot('catch-up');
        const publisher = new Publisher(latest, options);
        if (activeGlobalsFence(publisher, latest.tree(publisher.head(options.dataBranch)))) {
          await publishBundle(latest, options);
          if (enabled && !failure) {
            const identity = publicationIdentity(latest, config.liveBranch);
            if (identity) {
              publications.push(identity);
              if (config.liveBranch === 'converter' && needsOutputs(latest, identity))
                handoff = identity;
            }
          }
        }
      }
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
    !/^[0-9a-f]{64}$/.test(pin.verifierSha256) ||
    createHash('sha256')
      .update(readFileSync(join(root, 'verify-publication.mjs')))
      .digest('hex') !== pin.verifierSha256 ||
    !/^[0-9a-f]{40}$/.test(pin.sourceSha) ||
    createHash('sha256')
      .update(readFileSync(join(root, 'publisher.mjs')))
      .digest('hex') !== pin.sha256
  )
    throw new Error('Publisher PIN mismatch');
  return pin as {
    sourceSha: string;
    sha256: string;
    verifierSha256: string;
    capabilities?: string[];
  };
}
