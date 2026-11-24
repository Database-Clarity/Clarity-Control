import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { catalog, source } from '../../apps/worker/src/catalog.js';
import { LocalRepository } from '../publisher/git.js';
import { Publisher } from '../publisher/publisher.js';
import { drainCurrentSaves } from '../publisher/currentSave.js';
import { SchedulePreparer } from '../schedule-prepare/prepare.js';
import { SandboxGit } from './sandbox-git.mjs';
import { createAdapter } from './sandbox-fetch.mjs';

const [, , configPath] = process.argv;
const { bindings, repoDirs, pin, generatorSha, publicKeyPem, keyFingerprint, siteOrigin } =
  JSON.parse(readFileSync(configPath!, 'utf8'));
const repos = Object.fromEntries(
  Object.entries(repoDirs).map(([name, directory]) => [name, new SandboxGit(directory)]),
);
const upstream = createAdapter({ repos, bindings, siteOrigin });
globalThis.fetch = (input, init) => upstream(new Request(input, init));

const data = repos[bindings.GITHUB_REPO];
// Keep LocalRepository's real commit/receipt/CAS implementation, with the sandbox's
// environment and a bulk read of the base snapshot to avoid thousands of Git processes.
class DisposableRepository extends LocalRepository {
  protected override preserveModes = true;
  private readonly prefetched = new Map<string, string>();
  private readonly pendingBlobs = new Map<string, Buffer>();

  protected override gitBytes(args: string[], input?: string | Buffer, env = {}) {
    return data.git(args, input, env);
  }

  prefetch(head: string) {
    const entries = data.treeEntries(head, true);
    const oids = entries
      .filter(({ type, name }) => type === 'blob' && name.endsWith('.json'))
      .map(({ oid }) => oid);
    for (const [oid, { bytes }] of data.objects(oids)) this.prefetched.set(oid, bytes.toString());
  }

  override blob(oid: string) {
    return this.pendingBlobs.get(oid)?.toString() ?? this.prefetched.get(oid) ?? super.blob(oid);
  }

  override writeBlob(text: string) {
    const bytes = Buffer.from(text);
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (!this.prefetched.has(oid)) this.pendingBlobs.set(oid, bytes);
    return oid;
  }

  override commit(...args: Parameters<LocalRepository['commit']>) {
    // Global proof materialization writes thousands of independent blobs. Import
    // them in one Git process with no ref commands, before committing their tree.
    if (this.pendingBlobs.size) {
      const stream = [...this.pendingBlobs.values()].flatMap((bytes) => [
        Buffer.from(`blob\ndata ${bytes.length}\n`),
        bytes,
        Buffer.from('\n'),
      ]);
      data.git(
        ['fast-import', '--quiet', '--done'],
        Buffer.concat([...stream, Buffer.from('done\n')]),
      );
      for (const [oid, bytes] of this.pendingBlobs) this.prefetched.set(oid, bytes.toString());
      this.pendingBlobs.clear();
    }
    return super.commit(...args);
  }
}

data.git(['config', 'publisher.simulator', 'true']);
const repository = new DisposableRepository(data.directory);
repository.prefetch(data.resolve(bindings.DATA_BRANCH));
const { facts, aliases, items } = await catalog(bindings, undefined, generatorSha);
const conflicts = await fetch(`${source(bindings, generatorSha)}/sandboxConflicts.json`);
if (!conflicts.ok) throw new Error('Missing pinned generator conflicts');
const publisher = new Publisher(repository, {
  repo: `${bindings.GITHUB_OWNER}/${bindings.GITHUB_REPO}`,
  dataBranch: bindings.DATA_BRANCH,
  liveBranch: bindings.LIVE_BRANCH,
  publicKey: publicKeyPem,
  keyFingerprint,
  publisherSha: pin.sourceSha,
  publisherDigest: pin.sha256,
  verifierDigest: pin.verifierSha256,
  generatorSha,
  aliases,
  facts,
  aliasFacts: { generatorSha, items },
  sandboxConflicts: await conflicts.json(),
  now: Date.now,
  runUrl: siteOrigin,
});
// The pipeline refreshes global proofs and the editor bundle from the same
// local refs. Report catalogs carry forward at their original snapshot SHA.
await drainCurrentSaves(publisher);
await new SchedulePreparer(publisher).drain();
await publisher.run();
