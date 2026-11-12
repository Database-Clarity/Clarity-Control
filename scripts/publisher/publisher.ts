import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  stableStringify,
  baseEnhancedPublishMessage,
  publishPayloadSchema,
  publishIntentDigest,
  publishMonth,
  publishOpIdSchema,
  exportLegacy,
  isTextlessDescription,
  publishableHash,
  tooltipSchema,
  permissionsSchema,
  pushedSchema,
  resolveAlias,
  type PublishPayload,
  type Aliases,
  type LegacyCatalog,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { stampUploads } from '../../apps/worker/src/stamp.js';
import { RefRace, type Repository, type Tree } from './git.js';
import { setTimeout } from 'node:timers/promises';

// Five unresolved retries total ~2.5 min. Simulator fixtures inject a no-wait backoff.
export const publishBackoff = () => setTimeout(30_000);

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const dataRef = (branch: string) => `refs/heads/${branch}`;
export const paths = (id: string) => {
  publishOpIdSchema.parse(id);
  const month = publishMonth(id);
  return {
    request: `publish/requests/${id}.json`,
    log: `publish/log/${month}/${id}.json`,
    receipt: `.publish/receipts/${month}/${id}.json`,
    candidate: `refs/heads/publish-candidate/${id}`,
  };
};
interface Entry {
  hash: number;
  digest: string;
  tooltipBlob: string;
}
export interface Receipt {
  opId: string;
  requestBlob: string;
  sourceCommit: string;
  liveParent: string;
  now: number;
  publisherSha: string;
  generatorSha: string;
  outcome: 'published' | 'unchanged';
  entries: Entry[];
  // Frozen rebase inputs: export output and changed set from S, never revalidated on recovery.
  exported: ReturnType<typeof exportLegacy>;
  changed: number[];
  requester: PublishPayload['requester'];
  intentDigest: string;
}
export interface Options {
  repo: string;
  dataBranch: string;
  liveBranch: string;
  publicKey: string;
  keyFingerprint: string;
  publisherSha: string;
  generatorSha: string;
  aliases: Aliases;
  facts: LegacyCatalog;
  now: () => number;
  runUrl: string;
  backoff?: (attempt: number) => Promise<void>;
}
export class Publisher {
  constructor(
    readonly git: Repository,
    readonly options: Options,
  ) {}
  head(branch: string) {
    const h = this.git.head(dataRef(branch));
    if (!h) throw new Error(`Missing branch ${branch}`);
    return h;
  }
  read<T>(tree: Tree, path: string): T | undefined {
    return tree[path] ? (JSON.parse(this.git.blob(tree[path])) as T) : undefined;
  }
  /** The data head can move after signing; check associations at the drain snapshot too. */
  checkAssociatedDescriptions(tree: Tree, tooltips: readonly Tooltip[]): void {
    const known = new Map(tooltips.map((tooltip) => [tooltip.hash, tooltip]));
    const visited = new Set<number>();
    const pending = [...tooltips];
    while (pending.length) {
      const tooltip = pending.pop()!;
      if (visited.has(tooltip.hash)) continue;
      visited.add(tooltip.hash);
      for (const reference of tooltip.associated) {
        const hash = resolveAlias(reference, this.options.aliases);
        let target = known.get(hash);
        if (!target) {
          const value = this.read<unknown>(tree, `tooltips/${hash}.json`);
          if (value === undefined) continue;
          target = tooltipSchema.parse(value);
          if (target.hash !== hash) throw new Error('Stored association tooltip hash mismatch');
          known.set(hash, target);
        }
        if (isTextlessDescription(target))
          throw new Error(`Association ${tooltip.hash} -> ${hash} has no text to publish`);
        if (!visited.has(hash)) pending.push(target);
      }
    }
  }
  queue(head: string): string[] {
    const pending = new Set(
      Object.keys(this.git.tree(head)).filter((p) =>
        /^publish\/requests\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/.test(p),
      ),
    );
    const added = new Map<string, number>();
    for (const [i, entry] of this.git.additions(head, 'publish/requests/').entries())
      if (pending.has(entry.path)) added.set(entry.path, i);
    return [...pending]
      .sort((a, b) => added.get(a)! - added.get(b)! || a.localeCompare(b))
      .map((p) => p.slice(17, -5));
  }
  async verifyRequest(blob: string, opId: string, tree: Tree) {
    const envelope = JSON.parse(this.git.blob(blob));
    if (typeof envelope.payload !== 'string' || typeof envelope.sig !== 'string')
      throw new Error('Invalid signed envelope');
    const key = createPublicKey(this.options.publicKey);
    const fingerprint = createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (
      fingerprint !== this.options.keyFingerprint ||
      !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.sig, 'base64'))
    )
      throw new Error('Invalid signature or key pin');
    const p = publishPayloadSchema.parse(JSON.parse(envelope.payload));
    if (
      stableStringify(p) !== envelope.payload ||
      (await publishIntentDigest(p)) !== p.intentDigest
    )
      throw new Error('Noncanonical or altered intent');
    if (
      p.opId !== opId ||
      p.repo !== this.options.repo ||
      p.dataBranch !== this.options.dataBranch ||
      p.liveBranch !== this.options.liveBranch
    )
      throw new Error('Request target mismatch');
    const permissions = permissionsSchema.parse(this.read(tree, 'config/permissions.json'));
    if (!['maintainer', 'editor'].includes(permissions.users[String(p.requester.id)]?.role))
      throw new Error('Requester revoked');
    return p;
  }
  receipt(commit: string, opId: string): Receipt | undefined {
    return this.read(this.git.tree(commit), paths(opId).receipt);
  }
  candidate(opId: string, blob: string) {
    const c = this.git.head(paths(opId).candidate);
    if (c) {
      const r = this.receipt(c, opId);
      if (!r || r.opId !== opId || r.requestBlob !== blob)
        throw new Error('Candidate mismatch; operator required');
      return { c, r };
    }
  }
  merge(parent: string, r: Receipt): { bytes: string; outcome: Receipt['outcome'] } {
    const tree = this.git.tree(parent);
    const live = this.read<{
      perks: Record<string, unknown>;
      databaseSettings: Record<string, unknown>;
    }>(tree, 'liveDescriptions.json');
    if (!live?.perks || !live.databaseSettings) throw new Error('Invalid live file');
    const entries = structuredClone(r.exported);
    stampUploads(entries, new Set(r.changed), live.perks, r.now, r.requester.login);
    const bytes = json({ ...live, perks: { ...live.perks, ...entries } });
    return {
      bytes,
      outcome: bytes === this.git.blob(tree['liveDescriptions.json']) ? 'unchanged' : 'published',
    };
  }
  buildCandidate(parent: string, receipt: Receipt) {
    const { bytes, outcome } = this.merge(parent, receipt);
    const r = { ...receipt, liveParent: parent, outcome };
    const tree = {
      ...this.git.tree(parent),
      'liveDescriptions.json': this.git.writeBlob(bytes),
      [paths(r.opId).receipt]: this.git.writeBlob(json(r)),
    };
    return this.git.commit(parent, tree, `Publish ${r.opId}`);
  }
  async record(
    opId: string,
    receipt: Receipt | undefined,
    candidate: string | undefined,
    result?: { status: string; error?: string; outcomes?: unknown },
    requestBlob?: string,
  ) {
    const p = paths(opId);
    for (let i = 0; i < 5; i++) {
      const h = this.head(this.options.dataBranch),
        tree = this.git.tree(h);
      if (tree[p.log]) return;
      const blob = receipt?.requestBlob ?? requestBlob ?? tree[p.request];
      let request: unknown;
      try {
        request = JSON.parse(this.git.blob(blob));
      } catch {
        request = { invalidRequestBlob: blob };
      }
      let intentDigest: string | undefined;
      try {
        intentDigest = JSON.parse((request as { payload: string }).payload).intentDigest;
      } catch {
        /* rejected malformed envelope */
      }
      if (receipt) {
        const pushed = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
        for (const e of receipt.entries) {
          pushed[e.hash] = e.digest;
          tree[`live/tooltips/${e.hash}.json`] = e.tooltipBlob;
        }
        tree['live/pushed.json'] = this.git.writeBlob(json(pushed));
      }
      if (tree[p.request] && tree[p.request] !== blob) {
        let strayIntent: string | undefined;
        try {
          strayIntent = JSON.parse(JSON.parse(this.git.blob(tree[p.request])).payload).intentDigest;
        } catch {
          /* malformed stray is a conflict */
        }
        let n = 1;
        while (tree[p.log.replace('.json', `.dup-${n}.json`)]) n++;
        tree[p.log.replace('.json', `.dup-${n}.json`)] = this.git.writeBlob(
          json({
            status:
              strayIntent !== undefined && strayIntent === (receipt?.intentDigest ?? intentDigest)
                ? 'duplicate'
                : 'conflict',
            requestBlob: tree[p.request],
          }),
        );
      }
      delete tree[p.request];
      // A commit cannot contain its own SHA. recordCommit is deliberately null; resolve it via log blob history.
      tree[p.log] = this.git.writeBlob(
        json({
          request,
          intentDigest: receipt?.intentDigest ?? intentDigest ?? null,
          candidateCommit: candidate ?? null,
          result: result ?? {
            status: receipt?.outcome === 'unchanged' ? 'unchanged' : 'done',
            outcomes: receipt?.entries.map((e) => ({
              hash: e.hash,
              digest: e.digest,
              status: receipt.outcome,
            })),
          },
          liveCommit: candidate ?? null,
          recordCommit: null,
          pins: receipt
            ? { publisherSha: receipt.publisherSha, generatorSha: receipt.generatorSha }
            : { publisherSha: this.options.publisherSha, generatorSha: this.options.generatorSha },
          runUrl: this.options.runUrl,
          times: { now: receipt?.now ?? this.options.now() },
        }),
      );
      const c = this.git.commit(h, tree, `Record ${opId}`);
      try {
        this.git.cas(dataRef(this.options.dataBranch), h, c);
        return;
      } catch (e) {
        if (!(e instanceof RefRace)) throw e;
      }
    }
    throw new Error('RECORD exhausted; drain stopped');
  }
  async duplicate(opId: string) {
    const p = paths(opId);
    for (let i = 0; i < 5; i++) {
      const h = this.head(this.options.dataBranch),
        t = this.git.tree(h);
      if (!t[p.request]) return;
      const original = this.read<{ intentDigest: string }>(t, p.log)!;
      let intent: string | undefined;
      try {
        intent = JSON.parse(JSON.parse(this.git.blob(t[p.request])).payload).intentDigest;
      } catch {
        /* conflict */
      }
      let n = 1;
      while (t[p.log.replace('.json', `.dup-${n}.json`)]) n++;
      t[p.log.replace('.json', `.dup-${n}.json`)] = this.git.writeBlob(
        json({
          status: intent === original.intentDigest ? 'duplicate' : 'conflict',
          requestBlob: t[p.request],
        }),
      );
      delete t[p.request];
      try {
        this.git.cas(
          dataRef(this.options.dataBranch),
          h,
          this.git.commit(h, t, `Close duplicate ${opId}`),
        );
        return;
      } catch (e) {
        if (!(e instanceof RefRace)) throw e;
      }
    }
    throw new Error('Duplicate closure raced');
  }
  async operation(opId: string) {
    const p = paths(opId),
      s = this.head(this.options.dataBranch),
      tree = this.git.tree(s);
    if (tree[p.log]) {
      await this.duplicate(opId);
      return;
    }
    const live = this.head(this.options.liveBranch),
      landed = this.receipt(live, opId);
    if (landed) {
      // Find the actual receipt-adding commit even if another writer advanced LIVE.
      const c = this.git.additions(live, p.receipt)[0]?.commit;
      if (!c) throw new Error('Receipt addition commit missing');
      await this.record(opId, landed, c);
      return;
    }
    const blob = tree[p.request];
    let candidate = this.candidate(opId, blob);
    if (!candidate) {
      let payload: PublishPayload;
      try {
        payload = await this.verifyRequest(blob, opId, tree);
      } catch (e) {
        await this.record(
          opId,
          undefined,
          undefined,
          { status: 'rejected', error: String(e) },
          blob,
        );
        return;
      }
      const entries: Entry[] = [],
        tooltips: Tooltip[] = [],
        outcomes: { hash: number; status: string }[] = [];
      const seen = new Set<number>();
      for (const hash of payload.hashes) {
        const canonical = resolveAlias(hash, this.options.aliases),
          oid = tree[`tooltips/${canonical}.json`];
        const tooltip = tooltipSchema.safeParse(oid ? JSON.parse(this.git.blob(oid)) : undefined);
        if (!tooltip.success || tooltip.data.hash !== canonical) {
          outcomes.push({ hash: canonical, status: 'missing' });
          continue;
        }
        const digest = await publishableHash(tooltip.data, this.options.aliases);
        outcomes.push({
          hash: canonical,
          status: digest === payload.expected[hash] ? 'accepted' : 'stale',
        });
        if (!seen.has(canonical)) {
          entries.push({ hash: canonical, digest, tooltipBlob: oid });
          tooltips.push(tooltip.data);
          seen.add(canonical);
        }
      }
      if (outcomes.some((e) => e.status !== 'accepted')) {
        await this.record(opId, undefined, undefined, { status: 'stale', outcomes }, blob);
        return;
      }
      if (tooltips.some(isTextlessDescription)) {
        await this.record(
          opId,
          undefined,
          undefined,
          { status: 'rejected', error: 'Tooltip has no text to publish' },
          blob,
        );
        return;
      }
      try {
        this.checkAssociatedDescriptions(tree, tooltips);
      } catch (error) {
        await this.record(
          opId,
          undefined,
          undefined,
          { status: 'rejected', error: String(error) },
          blob,
        );
        return;
      }
      if (tooltips.some((t) => !t.custom && !this.options.facts[t.hash])) {
        await this.record(
          opId,
          undefined,
          undefined,
          { status: 'rejected', error: 'Missing generator facts' },
          blob,
        );
        return;
      }
      // The data head can advance after the Worker signs. In particular, stale
      // translation fallback can hide raw native markup from publishableHash.
      // Reject it terminally instead of letting exportLegacy wedge the queue.
      if (
        tooltips.some((tooltip) =>
          Object.values(tooltip.text).some((translation) => translation?.text.includes('{{')),
        )
      ) {
        await this.record(
          opId,
          undefined,
          undefined,
          { status: 'rejected', error: baseEnhancedPublishMessage },
          blob,
        );
        return;
      }
      const now = this.options.now(),
        pushed = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
      const r: Receipt = {
        opId,
        requestBlob: blob,
        sourceCommit: s,
        liveParent: live,
        now,
        publisherSha: this.options.publisherSha,
        generatorSha: this.options.generatorSha,
        outcome: 'published',
        entries,
        exported: exportLegacy(tooltips, now, this.options.facts, this.options.aliases),
        changed: entries.filter((e) => pushed[e.hash] !== e.digest).map((e) => e.hash),
        requester: payload.requester,
        intentDigest: payload.intentDigest,
      };
      const c = this.buildCandidate(live, r);
      for (let i = 0; i < 6 && !candidate; i++) {
        try {
          this.git.cas(p.candidate, undefined, c);
        } catch {
          /* ambiguous: always read back */
        }
        candidate = this.candidate(opId, blob);
      }
      if (!candidate) throw new Error('Candidate create unresolved');
    }
    let rebases = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      candidate = this.candidate(opId, blob);
      if (!candidate) throw new Error('Candidate disappeared');
      const { c, r } = candidate,
        l = this.head(this.options.liveBranch);
      const found = this.receipt(l, opId);
      if (found || this.git.ancestor(c, l)) {
        await this.record(opId, found ?? r, c);
        try {
          this.git.cas(p.candidate, c, undefined);
        } catch {
          /* best effort */
        }
        return;
      }
      if (l === r.liveParent) {
        let pushed = false;
        try {
          this.git.cas(dataRef(this.options.liveBranch), l, c);
          pushed = true;
        } catch {
          /* unresolved: SAME candidate next attempt */
        }
        if (pushed) {
          await this.record(opId, r, c);
          try {
            this.git.cas(p.candidate, c, undefined);
          } catch {
            /* best effort */
          }
          return;
        }
      } else {
        if (++rebases > 3) throw new Error('Rebase limit');
        const next = this.buildCandidate(l, r);
        try {
          this.git.cas(p.candidate, c, next);
        } catch {
          /* reread on next iteration */
        }
        continue;
      }
      if (attempt < 5) await (this.options.backoff ?? publishBackoff)(attempt);
    }
    throw new Error('Publish unresolved; no later operation may run');
  }
  bundle() {
    const h = this.head(this.options.dataBranch),
      t = this.git.tree(h),
      ref = dataRef('editor-data-bundle'),
      old = this.git.head(ref);
    const prior = old
      ? this.read<{ sourceCommit: string }>(this.git.tree(old), 'bundle.json')
      : undefined;
    if (prior?.sourceCommit === h) return;
    if (prior && !this.git.ancestor(prior.sourceCommit, h))
      throw new Error('Bundle source would move backwards');
    const tooltipPaths = Object.keys(t)
      .filter((p) => p.startsWith('tooltips/'))
      .sort();
    if (!tooltipPaths.length) throw new Error('No tooltips found');
    const tooltips = Object.fromEntries(
      tooltipPaths.map((p) => {
        if (!/^tooltips\/(0|[1-9]\d*)\.json$/.test(p)) throw new Error('Unexpected tooltip entry');
        const hash = p.slice(9, -5),
          tooltip = tooltipSchema.parse(this.read(t, p));
        if (String(tooltip.hash) !== hash) throw new Error('Tooltip hash does not match filename');
        return [hash, tooltip];
      }),
    );
    const publishQueue = this.queue(h).map((id) => {
      try {
        const e = this.read<{ payload: string }>(t, paths(id).request);
        const p = publishPayloadSchema.parse(JSON.parse(e!.payload));
        return { opId: id, requester: p.requester, hashes: p.hashes, createdAt: p.createdAt };
      } catch {
        return { opId: id, invalid: true };
      }
    });
    const bundle = {
      sourceCommit: h,
      generatedAt: new Date(this.options.now()).toISOString(),
      tooltips,
      permissions: permissionsSchema.parse(this.read(t, 'config/permissions.json')),
      pushed: pushedSchema.parse(this.read(t, 'live/pushed.json')),
      publishQueue,
    };
    const c = this.git.commit(
      old,
      { 'bundle.json': this.git.writeBlob(json(bundle)) },
      `Bundle ${h}`,
    );
    this.git.cas(ref, old, c);
  }
  async run() {
    const start = this.options.now();
    try {
      if (this.queue(this.head(this.options.dataBranch)).length) this.bundle();
      for (let n = 0; n < 20 && this.options.now() - start < 20 * 60_000; n++) {
        const [id] = this.queue(this.head(this.options.dataBranch));
        if (!id) break;
        await this.operation(id);
      }
    } finally {
      this.bundle();
    }
  }
}
