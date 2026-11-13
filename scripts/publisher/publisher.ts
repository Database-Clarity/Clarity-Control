import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  stableStringify,
  baseEnhancedPublishMessage,
  isHeldSetBonus,
  setBonusHoldMessage,
  publishPayloadSchema,
  parsePublishRequestPayload,
  publishRequestIntentDigest,
  publishMonth,
  publishOpIdSchema,
  exportLegacy,
  mergeLivePerks,
  findElementTags,
  isTextlessDescription,
  publishableHash,
  tooltipSchema,
  permissionsSchema,
  pushedSchema,
  resolveAlias,
  mergeSandboxPointers,
  sandboxPointersPath,
  sandboxPointersSchema,
  type PublishPayload,
  type PublishRequestPayload,
  type Aliases,
  type SandboxConflicts,
  type LegacyCatalog,
  type Tooltip,
} from '../../packages/core/src/index.js';
import {
  activate,
  activationConflictSchema,
  approvedDigest,
  batchPublishPayloadSchema,
  batchSchema,
  compose,
  schedulePaths,
  type BatchPublishPayload,
} from '@clarity/core/schedule';
import { stampUploads } from '../../apps/worker/src/stamp.js';
import { RefRace, type Repository, type Tree } from './git.js';
import {
  batchMembers,
  editDue,
  editIndex,
  iso,
  resolveActivationMessage,
  supersededMessage,
  unpublishedMessage,
  withEvent,
} from './batch.js';
import { setTimeout } from 'node:timers/promises';

// Five unresolved retries total ~2.5 min. Simulator fixtures inject a no-wait backoff.
export const publishBackoff = () => setTimeout(30_000);

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** The first exported hash whose strings still hold an element-tagged span or a preview marker. */
export function unloweredEntry(entries: Record<string, unknown>): string | undefined {
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
  for (const [hash, entry] of Object.entries(entries))
    if (strings(entry).some((text) => /[\uE000\uE001]/.test(text) || findElementTags(text).length))
      return hash;
  return undefined;
}
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
  /** Batch operations only (spec "Data model"); sourceCommit is then the claim commit S'. */
  batchId?: string;
  contentRevision?: number;
}
/** When the live write was confirmed by this run's CAS, or first observed after an ambiguity (R8). */
export interface Landing {
  at: number;
  source: 'cas' | 'observed';
}
type Failure = { status: 'stale' | 'rejected' | 'superseded'; error?: string; outcomes?: unknown };
/** A pending request as the queue orders it, read WITHOUT verification (ordering only). */
type QueueEntry =
  | { opId: string; kind: 'push'; createdAt?: number; payload?: PublishPayload }
  | { opId: string; kind: 'batch'; key: number; due: boolean; payload: BatchPublishPayload };
export interface Options {
  repo: string;
  dataBranch: string;
  liveBranch: string;
  publicKey: string;
  keyFingerprint: string;
  publisherSha: string;
  generatorSha: string;
  aliases: Aliases;
  /**
   * The generator's sandboxConflicts.json at `generatorSha`, like `aliases`. Maintainer picks in
   * the data branch's config/sandbox-pointers.json join the aliases only through it (PIN capability
   * `sandboxPointers`); without it no pick applies, so stale reviews are refused, never mis-exported.
   */
  sandboxConflicts?: SandboxConflicts;
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
  writeBlob(bytes: string) {
    return this.git.writeBlob(bytes);
  }
  /**
   * Generator aliases plus the maintainer sandbox picks at this snapshot (core mergeSandboxPointers,
   * the same merge as the Worker and the editor). A malformed picks file throws: fail closed.
   */
  aliasesAt(tree: Tree): Aliases {
    const raw = this.read<unknown>(tree, sandboxPointersPath);
    if (raw === undefined) return this.options.aliases;
    const pointers = sandboxPointersSchema.parse(raw);
    return mergeSandboxPointers(
      this.options.aliases,
      this.options.sandboxConflicts ?? {},
      pointers,
    );
  }
  /**
   * The live-merge recompute for a publish from this snapshot (core mergeLivePerks): every key the
   * picks file names, with the same merged aliases the export used. No picks file: none (v2).
   */
  pickRecomputeAt(tree: Tree) {
    const raw = this.read<unknown>(tree, sandboxPointersPath);
    if (raw === undefined) return undefined;
    const keys = Object.keys(sandboxPointersSchema.parse(raw).pointers);
    return keys.length
      ? { keys, aliases: this.aliasesAt(tree), catalog: this.options.facts }
      : undefined;
  }
  /** Check direct association targets at the drain snapshot, without walking their drafts. */
  checkAssociatedDescriptions(
    tree: Tree,
    tooltips: readonly Tooltip[],
    aliases: Aliases = this.options.aliases,
  ): void {
    const known = new Map(tooltips.map((tooltip) => [tooltip.hash, tooltip]));
    for (const tooltip of tooltips) {
      for (const reference of tooltip.associated) {
        const hash = resolveAlias(reference, aliases);
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
      }
    }
  }
  /** Every pending request in git addition order, classified for ordering (unverified). */
  pendingRequests(head: string): QueueEntry[] {
    const tree = this.git.tree(head);
    const pending = new Set(
      Object.keys(tree).filter((p) =>
        /^publish\/requests\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/.test(p),
      ),
    );
    const added = new Map<string, number>();
    for (const [i, entry] of this.git.additions(head, 'publish/requests/').entries())
      if (pending.has(entry.path)) added.set(entry.path, i);
    const now = this.options.now();
    return [...pending]
      .sort((a, b) => added.get(a)! - added.get(b)! || a.localeCompare(b))
      .map((p): QueueEntry => {
        const opId = p.slice(17, -5);
        let value: unknown;
        try {
          value = JSON.parse(this.read<{ payload: string }>(tree, p)!.payload);
        } catch {
          return { opId, kind: 'push' };
        }
        const batch = batchPublishPayloadSchema.safeParse(value);
        if (batch.success) {
          const notBefore = Date.parse(batch.data.notBefore);
          return {
            opId,
            kind: 'batch',
            key: Math.max(notBefore, Date.parse(batch.data.createdAt)),
            due: notBefore <= now,
            payload: batch.data,
          };
        }
        const push = publishPayloadSchema.safeParse(value);
        return push.success
          ? { opId, kind: 'push', createdAt: Date.parse(push.data.createdAt), payload: push.data }
          : { opId, kind: 'push' };
      });
  }
  /**
   * The drain order (spec "Publication path" 3): pending `push` requests (and anything that is not
   * a valid batch request, which then fails verification) in git addition order, with each DUE
   * batch request positioned at max(notBefore, createdAt): before the first push created at or
   * after that instant. A batch not yet due (notBefore > runner clock) is neither drained nor
   * pending work; scheduledQueue lists it.
   */
  queue(head: string): string[] {
    const entries = this.pendingRequests(head);
    const batches = entries
      .filter((e) => e.kind === 'batch' && e.due)
      .map((e, i) => ({ e, i, key: (e as { key: number }).key }))
      .sort((a, b) => a.key - b.key || a.i - b.i);
    const order: string[] = [];
    for (const e of entries) {
      if (e.kind === 'batch') continue;
      if (e.createdAt !== undefined)
        while (batches.length && batches[0].key <= e.createdAt) order.push(batches.shift()!.e.opId);
      order.push(e.opId);
    }
    return [...order, ...batches.map((b) => b.e.opId)];
  }
  /** Batch requests not yet due, soonest first (bundle.json `scheduledQueue`). */
  scheduledQueue(head: string): BatchPublishPayload[] {
    return this.pendingRequests(head)
      .flatMap((e) => (e.kind === 'batch' && !e.due ? [e.payload] : []))
      .sort((a, b) => a.notBefore.localeCompare(b.notBefore) || a.opId.localeCompare(b.opId));
  }
  async verifyRequest(blob: string, opId: string, tree: Tree): Promise<PublishRequestPayload> {
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
    const p = await parsePublishRequestPayload(JSON.parse(envelope.payload));
    if (
      stableStringify(p) !== envelope.payload ||
      (await publishRequestIntentDigest(p)) !== p.intentDigest
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
    const picks = this.pickRecomputeAt(this.git.tree(r.sourceCommit));
    const bytes = json({ ...live, perks: mergeLivePerks(live.perks, entries, picks) });
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
    landing?: Landing,
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
      let batchPayload: BatchPublishPayload | undefined;
      try {
        const value = JSON.parse((request as { payload: string }).payload);
        intentDigest = value.intentDigest;
        batchPayload = batchPublishPayloadSchema.safeParse(value).data;
      } catch {
        /* rejected malformed envelope */
      }
      // Batch requests: activation, conflict files, and the batch/due/index updates join THIS
      // commit (spec "Publication path" 6), recomputed from S' and this head on every attempt.
      const batchTimes = batchPayload
        ? this.recordBatch(tree, opId, batchPayload, receipt, candidate, result, landing)
        : undefined;
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
          times: { now: receipt?.now ?? this.options.now(), ...batchTimes },
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
  async operation(opId: string, attempt = 0): Promise<void> {
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
      await this.record(opId, landed, c, undefined, undefined, {
        at: this.options.now(),
        source: 'observed',
      });
      return;
    }
    const blob = tree[p.request];
    // A claim retry (attempt > 0) re-reads the head: a request removed meanwhile (unschedule) is gone.
    if (attempt && !blob) return;
    let candidate = this.candidate(opId, blob);
    if (!candidate) {
      let payload: PublishRequestPayload;
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
      let aliases: Aliases;
      try {
        aliases = this.aliasesAt(tree);
      } catch (e) {
        await this.record(
          opId,
          undefined,
          undefined,
          { status: 'rejected', error: `Invalid ${sandboxPointersPath}: ${String(e)}` },
          blob,
        );
        return;
      }
      if (payload.kind === 'batch') {
        const r = await this.claimBatch(opId, blob, s, tree, live, payload, aliases, attempt);
        if (!r) return;
        candidate = this.createCandidate(opId, blob, live, r);
      } else {
        const entries: Entry[] = [],
          tooltips: Tooltip[] = [],
          outcomes: { hash: number; status: string }[] = [];
        const seen = new Set<number>();
        // Publisher guard (R3): a hash with an activation conflict file publishes only after the
        // conflict is resolved, so a manual request can never overwrite the batch's live state.
        const blocked = [...new Set(payload.hashes.map((h) => resolveAlias(h, aliases)))].filter(
          (h) => tree[schedulePaths.conflict(h)],
        );
        if (blocked.length) {
          await this.record(
            opId,
            undefined,
            undefined,
            { status: 'rejected', error: `${resolveActivationMessage}: ${blocked.join(', ')}` },
            blob,
          );
          return;
        }
        for (const hash of payload.hashes) {
          const canonical = resolveAlias(hash, aliases),
            oid = tree[`tooltips/${canonical}.json`];
          const tooltip = tooltipSchema.safeParse(oid ? JSON.parse(this.git.blob(oid)) : undefined);
          if (!tooltip.success || tooltip.data.hash !== canonical) {
            outcomes.push({ hash: canonical, status: 'missing' });
            continue;
          }
          const digest = await publishableHash(tooltip.data, aliases);
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
        const checked = this.checkAndExport(tree, tooltips, aliases);
        if ('error' in checked) {
          await this.record(
            opId,
            undefined,
            undefined,
            { status: 'rejected', error: checked.error },
            blob,
          );
          return;
        }
        const pushed = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
        const r: Receipt = {
          opId,
          requestBlob: blob,
          sourceCommit: s,
          liveParent: live,
          now: checked.now,
          publisherSha: this.options.publisherSha,
          generatorSha: this.options.generatorSha,
          outcome: 'published',
          entries,
          exported: checked.exported,
          changed: entries.filter((e) => pushed[e.hash] !== e.digest).map((e) => e.hash),
          requester: payload.requester,
          intentDigest: payload.intentDigest,
        };
        candidate = this.createCandidate(opId, blob, live, r);
      }
    }
    let rebases = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      candidate = this.candidate(opId, blob);
      if (!candidate) throw new Error('Candidate disappeared');
      const { c, r } = candidate,
        l = this.head(this.options.liveBranch);
      const found = this.receipt(l, opId);
      if (found || this.git.ancestor(c, l)) {
        await this.record(opId, found ?? r, c, undefined, undefined, {
          at: this.options.now(),
          source: 'observed',
        });
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
          await this.record(opId, r, c, undefined, undefined, {
            at: this.options.now(),
            source: 'cas',
          });
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
  /**
   * The manual-publish content checks and the export, shared by `push` and `batch` (same order,
   * same messages). An error is a terminal rejection before any write.
   */
  checkAndExport(
    tree: Tree,
    tooltips: Tooltip[],
    aliases: Aliases,
  ): { error: string } | { now: number; exported: ReturnType<typeof exportLegacy> } {
    if (tooltips.some(isTextlessDescription)) return { error: 'Tooltip has no text to publish' };
    try {
      this.checkAssociatedDescriptions(tree, tooltips, aliases);
    } catch (error) {
      return { error: String(error) };
    }
    if (tooltips.some((t) => !t.custom && !this.options.facts[t.hash]))
      return { error: 'Missing generator facts' };
    // The data head can advance after the Worker signs. In particular, stale
    // translation fallback can hide raw native markup from publishableHash.
    // Reject it terminally instead of letting exportLegacy wedge the queue.
    if (
      tooltips.some((tooltip) =>
        Object.values(tooltip.text).some((translation) => translation?.text.includes('{{')),
      )
    )
      return { error: baseEnhancedPublishMessage };
    // Set bonuses wait for cut-over (owner 2026-11-11): a terminal rejection before any write.
    if (tooltips.some((t) => isHeldSetBonus(t, this.options.facts[t.hash])))
      return { error: setBonusHoldMessage };
    const now = this.options.now();
    const exported = exportLegacy(tooltips, now, this.options.facts, aliases);
    // Fail closed: exportLegacy lowers element-tagged text to today's `<solar/>Scorch`. An
    // export that still holds a tagged span (or a preview marker) would make apps drop text.
    const unlowered = unloweredEntry(exported);
    if (unlowered !== undefined)
      return { error: `The export of tooltip ${unlowered} still holds element-tagged text` };
    return { now, exported };
  }
  createCandidate(opId: string, blob: string, live: string, r: Receipt) {
    const p = paths(opId);
    const c = this.buildCandidate(live, r);
    let candidate: ReturnType<Publisher['candidate']>;
    for (let i = 0; i < 6 && !candidate; i++) {
      try {
        this.git.cas(p.candidate, undefined, c);
      } catch {
        /* ambiguous: always read back */
      }
      candidate = this.candidate(opId, blob);
    }
    if (!candidate) throw new Error('Candidate create unresolved');
    return candidate;
  }
  /**
   * What a batch publishes from snapshot `tree` (spec "Publication path" 4, "Composition"): every
   * guard on effective publication, inside the publisher (I1). Read-only; a failure is terminal.
   */
  async batchPlan(
    tree: Tree,
    payload: BatchPublishPayload,
    aliases: Aliases,
  ): Promise<
    | { failure: Failure }
    | {
        entries: Entry[];
        now: number;
        exported: ReturnType<typeof exportLegacy>;
        changed: number[];
      }
  > {
    let members;
    try {
      members = batchMembers(this, tree, payload.batchId);
    } catch (e) {
      return { failure: { status: 'rejected', error: `Invalid batch member: ${String(e)}` } };
    }
    if (members.map((m) => m.hash).join() !== payload.hashes.join())
      return {
        failure: { status: 'rejected', error: 'Batch members differ from the signed request' },
      };
    if ((await approvedDigest(members)) !== payload.approvedDigest)
      return {
        failure: { status: 'rejected', error: 'Batch content differs from what was approved' },
      };
    const blocked = members.filter((m) => tree[schedulePaths.conflict(m.hash)]).map((m) => m.hash);
    if (blocked.length)
      return {
        failure: {
          status: 'rejected',
          error: `${resolveActivationMessage}: ${blocked.join(', ')}`,
        },
      };
    let pushed: Record<string, string>;
    try {
      pushed = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
    } catch (e) {
      return { failure: { status: 'rejected', error: `Invalid live/pushed.json: ${String(e)}` } };
    }
    const outcomes: { hash: number; status: string; fields?: string[]; reason?: string }[] = [];
    const tooltips: Tooltip[] = [];
    for (const m of members) {
      const stored = (path: string) => {
        const value = this.read<unknown>(tree, path);
        if (value === undefined) return null;
        const tooltip = tooltipSchema.parse(value);
        if (tooltip.hash !== m.hash) throw new Error(`${path} carries another hash`);
        return tooltip;
      };
      let current: Tooltip | null, snapshot: Tooltip | null;
      try {
        current = stored(`tooltips/${m.hash}.json`);
        snapshot = stored(`live/tooltips/${m.hash}.json`);
      } catch (e) {
        return { failure: { status: 'rejected', error: String(e) } };
      }
      if (resolveAlias(m.hash, aliases) !== m.hash) {
        outcomes.push({ hash: m.hash, status: 'alias' });
        continue;
      }
      // Non-translation merge3 against current (translations follow Q4 and never block).
      const activation = activate({ base: m.base, current, proposed: m.proposed });
      if (!activation.ok) {
        outcomes.push({ hash: m.hash, status: 'stale', fields: activation.fields });
        continue;
      }
      const composed = compose({
        hash: m.hash,
        base: m.base,
        proposed: m.proposed,
        snapshot,
        pushed: pushed[m.hash] !== undefined,
      });
      if (composed.status === 'stale') {
        outcomes.push({ hash: m.hash, status: 'stale', reason: composed.reason });
        continue;
      }
      // Root ruling 2026-11-13: a batch-changed field whose base differs from the published
      // snapshot would publish saved-but-unpublished work (I3): refused, never acknowledged.
      if (composed.status === 'overlay' && composed.unpublished.length) {
        outcomes.push({
          hash: m.hash,
          status: 'unpublished',
          fields: composed.unpublished,
          reason: unpublishedMessage,
        });
        continue;
      }
      outcomes.push({ hash: m.hash, status: 'accepted' });
      tooltips.push(composed.tooltip);
    }
    if (outcomes.some((o) => o.status !== 'accepted'))
      return { failure: { status: 'stale', outcomes } };
    const checked = this.checkAndExport(tree, tooltips, aliases);
    if ('error' in checked) return { failure: { status: 'rejected', error: checked.error } };
    const entries: Entry[] = [];
    for (const tooltip of tooltips)
      entries.push({
        hash: tooltip.hash,
        digest: await publishableHash(tooltip, aliases),
        tooltipBlob: this.git.writeBlob(json(tooltip)),
      });
    return {
      entries,
      now: checked.now,
      exported: checked.exported,
      changed: entries.filter((e) => pushed[e.hash] !== e.digest).map((e) => e.hash),
    };
  }
  /** S' for a batch this opId already claimed: the oldest commit of the head's claimed run. */
  claimCommit(batchId: string, opId: string): string {
    const commits = this.git.history(dataRef(this.options.dataBranch));
    let found: string | undefined;
    for (let i = commits.length - 1, n = 0; i >= 0 && n < 1000; i--, n++) {
      const batch = batchSchema.safeParse(
        this.read<unknown>(this.git.tree(commits[i]), schedulePaths.batch(batchId)),
      ).data;
      if (batch?.claim?.opId !== opId) break;
      found = commits[i];
    }
    if (!found) throw new Error('Claim commit not found; operator required');
    return found;
  }
  /**
   * Validate at S, then CLAIM (spec "Publication path" 4, I2): one CAS S → S' marks the batch
   * publishing and its due entry claimed. A race or an ambiguous CAS re-reads the head and
   * re-validates from the top. A batch this opId already claimed (a run died after the claim)
   * resumes from S'. Returns the frozen receipt, or undefined once the operation is handled.
   */
  async claimBatch(
    opId: string,
    blob: string,
    s: string,
    tree: Tree,
    live: string,
    payload: BatchPublishPayload,
    aliases: Aliases,
    attempt: number,
  ): Promise<Receipt | undefined> {
    const fail = async (failure: Failure) => {
      await this.record(opId, undefined, undefined, failure, blob);
      return undefined;
    };
    const path = schedulePaths.batch(payload.batchId);
    const parsed = batchSchema.safeParse(this.read<unknown>(tree, path));
    if (!parsed.success)
      return fail({ status: 'rejected', error: 'Missing or invalid batch.json' });
    const batch = parsed.data;
    const claimed =
      batch.status === 'publishing' && batch.opId === opId && batch.claim?.opId === opId;
    if (
      batch.opId !== opId ||
      (batch.status !== 'scheduled' && !claimed) ||
      batch.scheduledContentRevision !== payload.contentRevision ||
      batch.contentRevision !== payload.contentRevision ||
      batch.notBefore !== payload.notBefore
    )
      return fail({ status: 'superseded', error: supersededMessage });
    const source = claimed ? this.claimCommit(payload.batchId, opId) : s;
    const at = claimed ? this.git.tree(source) : tree;
    let frozenAliases = aliases;
    if (claimed)
      try {
        frozenAliases = this.aliasesAt(at);
      } catch (e) {
        return fail({ status: 'rejected', error: `Invalid ${sandboxPointersPath}: ${String(e)}` });
      }
    const plan = await this.batchPlan(at, payload, frozenAliases);
    if ('failure' in plan) return fail(plan.failure);
    let sourceCommit = source;
    if (!claimed) {
      const next = { ...tree };
      const claimedAt = iso(this.options.now());
      const updated = withEvent(
        this,
        next,
        batch,
        { status: 'publishing', claim: { opId, claimedAt } },
        { at: claimedAt, by: payload.requester, action: 'claim', notBefore: payload.notBefore },
      );
      next[path] = this.git.writeBlob(json(updated));
      editDue(this, next, (entries) => [
        ...entries.filter((e) => e.batchId !== batch.id && e.opId !== opId),
        { batchId: batch.id, opId, notBefore: payload.notBefore, claimed: true },
      ]);
      editIndex(this, next, updated, payload.hashes, claimedAt);
      const c = this.git.commit(s, next, `Claim batch ${batch.id} for ${opId}`);
      try {
        this.git.cas(dataRef(this.options.dataBranch), s, c);
        sourceCommit = c;
      } catch {
        // RefRace (a Worker write won) or ambiguous: re-read and re-validate from the top.
        if (attempt >= 5) throw new Error('Claim unresolved; no later operation may run');
        await this.operation(opId, attempt + 1);
        return undefined;
      }
    }
    return {
      opId,
      requestBlob: blob,
      sourceCommit,
      liveParent: live,
      now: plan.now,
      publisherSha: this.options.publisherSha,
      generatorSha: this.options.generatorSha,
      outcome: 'published',
      entries: plan.entries,
      exported: plan.exported,
      changed: plan.changed,
      requester: payload.requester,
      intentDigest: payload.intentDigest,
      batchId: payload.batchId,
      contentRevision: payload.contentRevision,
    };
  }
  /**
   * The batch part of RECORD at head `tree` (edited in place). With a landed receipt: activation
   * per member (base and proposed from S' = receipt.sourceCommit, current from this head),
   * conflict files, and the published batch. Without one (stale, rejected, superseded): the batch
   * returns to draft, but only while it is still this opId's (R15). Returns the log's extra times.
   */
  recordBatch(
    tree: Tree,
    opId: string,
    payload: BatchPublishPayload,
    receipt: Receipt | undefined,
    candidate: string | undefined,
    result: { status: string; error?: string; outcomes?: unknown } | undefined,
    landing: Landing | undefined,
  ) {
    const recordedAt = iso(this.options.now());
    const path = schedulePaths.batch(payload.batchId);
    const dropDue = () => editDue(this, tree, (entries) => entries.filter((e) => e.opId !== opId));
    if (!receipt) {
      dropDue();
      const batch = batchSchema.safeParse(this.read<unknown>(tree, path)).data;
      const owned =
        batch &&
        batch.opId === opId &&
        (batch.status === 'scheduled' ||
          (batch.status === 'publishing' && batch.claim?.opId === opId));
      if (owned) {
        const status = (['stale', 'rejected', 'superseded'] as const).find(
          (s) => s === result?.status,
        );
        if (!status) throw new Error(`Unexpected batch result ${result?.status}`);
        const outcomes = Array.isArray(result?.outcomes) ? result.outcomes : undefined;
        const updated = withEvent(
          this,
          tree,
          batch,
          {
            status: 'draft',
            opId: null,
            scheduledContentRevision: null,
            claim: null,
            notBefore: null,
            zone: null,
            result: {
              opId,
              status,
              recordedAt,
              ...(outcomes ? { outcomes } : {}),
              ...(result?.error ? { error: result.error.slice(0, 2000) } : {}),
            },
          },
          { at: recordedAt, by: payload.requester, action: status },
        );
        tree[path] = this.git.writeBlob(json(updated));
        editIndex(this, tree, updated, payload.hashes, recordedAt);
      }
      return { recordedAt };
    }
    if (receipt.batchId !== payload.batchId) throw new Error('Receipt batch mismatch');
    const frozen = this.git.tree(receipt.sourceCommit);
    const members = batchMembers(this, frozen, payload.batchId);
    const snapshotAt = (hash: number) => {
      const value = this.read<unknown>(frozen, `live/tooltips/${hash}.json`);
      return value === undefined ? null : tooltipSchema.parse(value);
    };
    const pushedAt = pushedSchema.parse(this.read(frozen, 'live/pushed.json'));
    // The composed snapshots exist only as receipt OIDs: rewrite them from S' (deterministic)
    // so a recovering runner holds the blobs, and fail closed if they ever differ.
    const byHash = new Map(members.map((m) => [m.hash, m]));
    for (const e of receipt.entries) {
      const m = byHash.get(e.hash);
      if (!m) throw new Error(`Receipt member ${e.hash} missing at S'; operator required`);
      const composed = compose({
        hash: m.hash,
        base: m.base,
        proposed: m.proposed,
        snapshot: snapshotAt(m.hash),
        pushed: pushedAt[m.hash] !== undefined,
      });
      if (
        composed.status === 'stale' ||
        this.git.writeBlob(json(composed.tooltip)) !== e.tooltipBlob
      )
        throw new Error(`Composition of ${e.hash} differs from its receipt; operator required`);
    }
    const batch = batchSchema.parse(this.read<unknown>(tree, path));
    if (batch.status !== 'publishing' || batch.opId !== opId || batch.claim?.opId !== opId)
      throw new Error(`Batch ${batch.id} is not claimed by ${opId}; operator required`);
    const outcomes: { hash: number; status: string; fields?: string[] }[] = [];
    for (const m of members) {
      const currentPath = `tooltips/${m.hash}.json`;
      const raw = this.read<unknown>(tree, currentPath);
      const current = raw === undefined ? null : tooltipSchema.parse(raw);
      const activation = activate({ base: m.base, current, proposed: m.proposed });
      if (activation.ok) {
        if (!current || stableStringify(current) !== stableStringify(activation.tooltip))
          tree[currentPath] = this.git.writeBlob(json(activation.tooltip));
        outcomes.push({ hash: m.hash, status: activation.created ? 'created' : 'activated' });
        continue;
      }
      // I4: keep current entirely; the authoritative conflict file lists the conflicted fields
      // and ALL batch-changed ones. Only the resolve route removes it.
      const conflictPath = schedulePaths.conflict(m.hash);
      if (tree[conflictPath])
        throw new Error(`Activation conflict for ${m.hash} already exists; operator required`);
      const file = activationConflictSchema.parse({
        hash: m.hash,
        batchId: batch.id,
        opId,
        fields: activation.fields,
        changed: activation.changed,
        base: m.base,
        proposed: m.proposed,
        currentAtRecord: current,
      });
      tree[conflictPath] = this.git.writeBlob(json(file));
      outcomes.push({ hash: m.hash, status: 'conflict', fields: activation.fields });
    }
    const land = landing ?? { at: this.options.now(), source: 'observed' as const };
    const landedAt = iso(land.at);
    const unchanged = receipt.outcome === 'unchanged';
    const updated = withEvent(
      this,
      tree,
      batch,
      {
        status: 'published',
        result: {
          opId,
          status: unchanged ? 'unchanged' : 'published',
          recordedAt,
          exportNow: iso(receipt.now),
          outcomes,
          ...(unchanged ? {} : { landedAt, landedAtSource: land.source, liveCommit: candidate }),
        },
      },
      {
        at: recordedAt,
        by: payload.requester,
        action: unchanged ? 'unchanged' : 'published',
        hashes: payload.hashes,
      },
    );
    tree[path] = this.git.writeBlob(json(updated));
    dropDue();
    editIndex(this, tree, updated, payload.hashes, recordedAt);
    return { landedAt, landedAtSource: land.source, recordedAt };
  }
  bundle() {
    const h = this.head(this.options.dataBranch),
      t = this.git.tree(h),
      ref = dataRef('editor-data-bundle'),
      old = this.git.head(ref),
      oldTree = old ? this.git.tree(old) : {};
    const prior = old ? this.read<{ sourceCommit: string }>(oldTree, 'bundle.json') : undefined;
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
    const batchEntry = (p: BatchPublishPayload) => ({
      opId: p.opId,
      kind: p.kind,
      batchId: p.batchId,
      requester: p.requester,
      hashes: p.hashes,
      createdAt: p.createdAt,
      notBefore: p.notBefore,
    });
    const publishQueue = this.queue(h).map((id) => {
      try {
        const e = this.read<{ payload: string }>(t, paths(id).request);
        const value = JSON.parse(e!.payload);
        if (value?.kind === 'batch') return batchEntry(batchPublishPayloadSchema.parse(value));
        const p = publishPayloadSchema.parse(value);
        return { opId: id, requester: p.requester, hashes: p.hashes, createdAt: p.createdAt };
      } catch {
        return { opId: id, invalid: true };
      }
    });
    // Batch requests not yet due: listed, never drained or counted as pending work (spec step 3).
    const scheduledQueue = this.scheduledQueue(h).map(batchEntry);
    // Maintainer sandbox picks ride along for the editor's alias view; omitted while there are
    // none. A malformed file is left out rather than stopping the bundle (and with it the queue):
    // publish requests are refused terminally on it (aliasesAt), and the Worker fails closed.
    const sandboxPointers = sandboxPointersSchema.safeParse(
      this.read<unknown>(t, sandboxPointersPath),
    ).data;
    const bundle = {
      sourceCommit: h,
      generatedAt: new Date(this.options.now()).toISOString(),
      tooltips,
      permissions: permissionsSchema.parse(this.read(t, 'config/permissions.json')),
      pushed: pushedSchema.parse(this.read(t, 'live/pushed.json')),
      ...(sandboxPointers && Object.keys(sandboxPointers.pointers).length
        ? { sandboxPointers }
        : {}),
      publishQueue,
      ...(scheduledQueue.length ? { scheduledQueue } : {}),
    };
    // The publisher owns only bundle.json: every other file on the bundle branch (the report
    // catalogs report-items*.json, rebuilt by the pipeline's report-items job) is carried
    // forward byte-identical, so no bundle push can delete them.
    const c = this.git.commit(
      old,
      { ...oldTree, 'bundle.json': this.git.writeBlob(json(bundle)) },
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
