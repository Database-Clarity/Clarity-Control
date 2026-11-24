import {
  buildLegacy,
  deployedLegacyPresets,
  type LegacyInput,
  type LegacyPreset,
} from '../../packages/export/src/legacy.js';
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
  exportWithInactiveMoves,
  globalsInPlaceCapability,
  globalsInPlacePath,
  globalsReleasePaths,
  applyInactiveLive,
  inactiveMovesPath,
  inactiveMovesSchema,
  inactivePublishableHash,
  hasUnpublishedInactiveMove,
  unreviewedInactiveMessage,
  isMovedInactive,
  selectedInactiveMoves,
  type InactiveMoves,
  mergeLivePerks,
  findElementTags,
  enhancedArrowMarkup,
  isTextlessDescription,
  tooltipSchema,
  permissionsSchema,
  pushedSchema,
  resolveAlias,
  aliasGroupsPath,
  aliasGroupsSchema,
  composeAliases,
  type AliasItems,
  sandboxPointersPath,
  sandboxPointersSchema,
  currentSaveStagePaths,
  type PublishPayload,
  type PublishRequestPayload,
  type Aliases,
  type SandboxConflicts,
  type LegacyCatalog,
  type Tooltip,
  type GlobalsInPlaceOptions,
} from '../../packages/core/src/index.js';
import {
  activate,
  activationConflictSchema,
  boundTranslationSources,
  approvedDigest,
  batchPublishPayloadSchema,
  batchSchema,
  compose,
  schedulePaths,
  scheduleIntentPaths,
  canClaimPreparedBatch,
  withField,
  type BatchMember,
  type BatchPublishPayload,
} from '@clarity/core/schedule';
import { stampUploads } from '../../apps/worker/src/stamp.js';
import { nameProofRequestSchema } from '../../apps/worker/src/globals/model.js';
import { snippetsPath } from '../../packages/core/src/customSnippets.js';
import { langSchema } from '../../packages/core/src/languages.js';
import { marksPath } from '../../packages/core/src/marks.js';
import { publicationSourcesPath } from '../../packages/core/src/globalsRelease/admission.js';
import {
  appCredits,
  requesterCredits,
  RefRace,
  type CommitCredits,
  type Repository,
  type Tree,
} from './git.js';
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
import {
  bundleGlobals,
  GlobalsPublisher,
  GlobalReleaseRejected,
  hasGlobals,
  type GlobalRelease,
  type GlobalReleaseReceipt,
} from './globals.js';
import { SchedulePreparer } from '../schedule-prepare/prepare.js';
import { drainCurrentSaves } from './currentSave.js';
import {
  assertInPlaceDocuments,
  assertInPlaceLibraries,
  assertInPlaceRoots,
  bundleInPlaceReview,
  globalsFence,
  liveGlobalsInput,
  provePublication,
  planInPlaceRelease,
  requireGlobalsMode,
  rewritePushed,
} from './globalsInPlace.js';
import {
  verifiedSource,
  verifiedRequest,
  verifyPreparedPublication,
  type PreparedPublication,
} from '../schedule-prepare/intents.js';

// Five unresolved retries total ~2.5 min. Simulator fixtures inject a no-wait backoff.
export const publishBackoff = () => setTimeout(30_000);

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/**
 * The first exported hash whose strings still hold an authoring form that exportLegacy lowers: an
 * element-tagged span or a preview marker, or a delimited variable or the arrow symbol (`#{`,
 * `<enhanced/>`; capability markupBraces). Fail closed: today's apps would drop the text or print
 * the markup. Any `#{` counts, braced name or not (real data has none).
 */
export function unloweredEntry(entries: Record<string, unknown>): string | undefined {
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
  const unlowered = (text: string) =>
    /[\uE000\uE001]/.test(text) ||
    findElementTags(text).length > 0 ||
    text.includes('#{') ||
    text.includes(enhancedArrowMarkup);
  for (const [hash, entry] of Object.entries(entries))
    if (strings(entry).some(unlowered)) return hash;
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
  verifierSha256?: string;
  outcome: 'published' | 'unchanged';
  entries: Entry[];
  // Frozen rebase inputs: export output and changed set from S, never revalidated on recovery.
  exported: ReturnType<typeof exportLegacy>;
  changed: number[];
  requester: PublishPayload['requester'];
  intentDigest: string;
  /** Batch operations only; sourceCommit is the claim or a revalidated snapshot after it. */
  batchId?: string;
  contentRevision?: number;
  globals?: GlobalReleaseReceipt;
  inPlace?: { globals: string[]; refills: number[]; refusals?: { id: string; error: string }[] };
}
/** When the live write was confirmed by this run's CAS, or first observed after an ambiguity (R8). */
export interface Landing {
  at: number;
  source: 'cas' | 'observed';
}
type BatchOutcome = { hash: number; status: string; fields?: string[]; reason?: string };
type Failure = {
  status: 'stale' | 'rejected' | 'superseded';
  error?: string;
  outcomes?: BatchOutcome[];
  /** Known authored-content refusal; never inferred from a generic repository error. */
  proposalRejected?: true;
  retryable?: true;
  /** Route an unclaimed globals refusal through the existing needs-attention preparation. */
  globals?: true;
};
/** A pending request as the queue orders it, read WITHOUT verification (ordering only). */
type QueueEntry =
  | { opId: string; kind: 'push'; createdAt?: number; payload?: PublishPayload }
  | {
      opId: string;
      kind: 'batch';
      key: number;
      due: boolean;
      /** batch.json at the head is publishing under this opId (a claim whose run died). */
      claimed: boolean;
      payload: BatchPublishPayload;
    };
export interface Options {
  repo: string;
  dataBranch: string;
  liveBranch: string;
  publicKey: string;
  keyFingerprint: string;
  publisherSha: string;
  /** Verified running bundle digest, supplied by CLI rather than persisted config. */
  publisherDigest?: string;
  publisherConfigDigest?: string;
  verifierDigest?: string;
  generatorSha: string;
  aliases: Aliases;
  /**
   * The generator's sandboxConflicts.json at `generatorSha`, like `aliases`. Maintainer picks in
   * the data branch's config/sandbox-pointers.json join the aliases only through it (PIN capability
   * `sandboxPointers`); without it no pick applies, so stale reviews are refused, never mis-exported.
   */
  sandboxConflicts?: SandboxConflicts;
  facts: LegacyCatalog;
  /** Complete generator items pinned alongside aliases and legacy facts; installed at G2. */
  aliasFacts?: { generatorSha: string; items: AliasItems };
  now: () => number;
  runUrl: string;
  backoff?: (attempt: number) => Promise<void>;
}
export class ConsumerOutputRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerOutputRejected';
  }
}
/** Only conversion of the merged proposal can attribute an output fault to that proposal. */
export class ProposalOutputRejected extends ConsumerOutputRejected {}
export class TextlessConsumerOutput extends ProposalOutputRejected {
  constructor(message: string) {
    super(message);
    this.name = 'TextlessConsumerOutput';
  }
}
class SourceAdvanced extends Error {
  constructor(
    readonly candidate: string,
    readonly requestBlob: string,
    readonly source: string,
    readonly head: string,
    readonly hashes: readonly number[],
    readonly batch = false,
  ) {
    super(
      batch
        ? 'The scheduled publish source kept changing. The batch is still due.'
        : 'The manual publish source kept changing. The request is still queued.',
    );
  }
}
class NamedPartRefusal extends ConsumerOutputRejected {
  constructor(
    message: string,
    readonly outcomes?: unknown,
  ) {
    super(message);
  }
}
const derivedGlobalPath = (path: string) => /^globals\/(?:proofs|review-pages)\//.test(path);
type EmptyOutputs = Map<LegacyPreset, Set<string>>;
export class Publisher {
  private checkedOutput?: { key: string; after: EmptyOutputs };
  private candidateOutput?: { commit: string; pin: string; after: EmptyOutputs };
  private reviewedRelease?: { key: string; release: GlobalRelease };
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
  aliasesAt(tree: Tree, options = this.options): Aliases {
    try {
      return Publisher.aliasesAt(
        options,
        this.read<unknown>(tree, aliasGroupsPath),
        this.read<unknown>(tree, sandboxPointersPath),
      );
    } catch (error) {
      throw new ConsumerOutputRejected(String(error));
    }
  }
  /** The read-only parity command shares the same pinned-fact checks and composition. */
  static aliasesAt(
    options: Pick<
      Options,
      'aliases' | 'facts' | 'generatorSha' | 'aliasFacts' | 'sandboxConflicts'
    >,
    raw: unknown,
    pointers: unknown,
  ): Aliases {
    const groups = raw === undefined ? undefined : aliasGroupsSchema.parse(raw);
    if (groups) {
      const facts = options.aliasFacts;
      if (
        !facts ||
        !/^[0-9a-f]{40}$/.test(facts.generatorSha) ||
        facts.generatorSha !== options.generatorSha
      )
        throw new Error('Alias groups require matching pinned generator facts');
      if (!facts.items || typeof facts.items !== 'object' || Array.isArray(facts.items))
        throw new Error('Alias groups require complete pinned generator items');
      // Do not mistake a LegacyCatalog or a partial group-only catalog for generator items.
      for (const hash of new Set([
        ...Object.keys(options.facts),
        ...Object.values(groups.groups).flatMap((group) => group.members.map(String)),
        ...Object.keys(facts.items ?? {}),
      ])) {
        const item = facts.items?.[hash];
        if (
          !item ||
          !Number.isInteger(item.hash) ||
          item.hash < 0 ||
          item.hash > 0xffffffff ||
          String(item.hash) !== hash ||
          typeof item.name !== 'string' ||
          typeof item.categoryId !== 'string' ||
          !item.categoryId ||
          typeof item.inGameDescription !== 'string' ||
          typeof options.facts[hash]?.name !== 'string' ||
          typeof options.facts[hash]?.type !== 'string'
        )
          throw new Error(`Incomplete pinned alias facts for ${hash}`);
        for (const flag of ['isEnhanced', 'exotic'] as const)
          if (item[flag] !== undefined && typeof item[flag] !== 'boolean')
            throw new Error(`Invalid pinned alias fact ${hash}.${flag}`);
        for (const field of ['plugCategoryHash', 'baseHash', 'dimBaseHash', 'itemHash'] as const)
          if (
            item[field] !== undefined &&
            (!Number.isInteger(item[field]) || item[field]! < 0 || item[field]! > 0xffffffff)
          )
            throw new Error(`Invalid pinned alias fact ${hash}.${field}`);
        if (
          item.owners !== undefined &&
          (!Array.isArray(item.owners) ||
            item.owners.some(
              (owner) => !Number.isInteger(owner) || owner < 0 || owner > 0xffffffff,
            ))
        )
          throw new Error(`Invalid pinned alias owners for ${hash}`);
      }
    }
    const composed = composeAliases(
      options.aliases,
      groups,
      options.aliasFacts?.items ?? {},
      options.sandboxConflicts ?? {},
      pointers === undefined ? undefined : sandboxPointersSchema.parse(pointers),
    );
    if (groups && composed.issues.length)
      throw new Error(`Alias group facts drift: ${JSON.stringify(composed.issues)}`);
    return composed.aliases;
  }
  movesAt(tree: Tree): InactiveMoves {
    try {
      return inactiveMovesSchema.parse(
        tree[inactiveMovesPath] ? this.read<unknown>(tree, inactiveMovesPath) : {},
      );
    } catch {
      throw new ConsumerOutputRejected(`Invalid ${inactiveMovesPath}`);
    }
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
          const stored = batchSchema.safeParse(
            this.read<unknown>(tree, schedulePaths.batch(batch.data.batchId)),
          ).data;
          return {
            opId,
            kind: 'batch',
            key: Math.max(notBefore, Date.parse(batch.data.createdAt)),
            due: notBefore <= now,
            claimed:
              stored?.status === 'publishing' &&
              stored.opId === opId &&
              stored.claim?.opId === opId,
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
   * pending work; scheduledQueue lists it. IN-FLIGHT operations drain before all fresh work, in
   * that order: a batch already CLAIMED by its opId, and any request with a publish candidate or
   * a receipt on live that is not yet recorded (a run died). Each was at the head of the queue
   * when it froze its inputs, and a request ordered ahead of it later (a batch committed after
   * the push's run began, or a push landing after a claim) would publish in between: the frozen
   * operation would then revert it on live, or it would drop the frozen one's live output.
   */
  queue(head: string): string[] {
    const tree = this.git.tree(head);
    const entries = this.pendingRequests(head).filter((entry) => {
      if (entry.kind !== 'batch') return true;
      const batch = batchSchema.safeParse(
        this.read(tree, schedulePaths.batch(entry.payload.batchId)),
      ).data;
      return (
        !batch ||
        batch.opId !== entry.opId ||
        !['preparing', 'needs_attention'].includes(batch.status)
      );
    });
    // Only a fresh due batch can be ordered ahead of a request that is already in flight (pushes
    // keep addition order), so the ref and receipt probes run only then (a remote head() is a
    // network round trip per request).
    const reorders = entries.some((e) => e.kind === 'batch' && e.due && !e.claimed);
    const liveHead = reorders ? this.git.head(dataRef(this.options.liveBranch)) : undefined;
    const inFlight = (e: QueueEntry) =>
      (e.kind === 'batch' && e.claimed) ||
      (reorders &&
        ((liveHead !== undefined && this.receipt(liveHead, e.opId) !== undefined) ||
          this.git.head(paths(e.opId).candidate) !== undefined));
    const fresh = entries.filter((e) => !inFlight(e));
    const claimed = entries.filter(inFlight).map((e) => e.opId);
    const batches = fresh
      .filter((e) => e.kind === 'batch' && e.due)
      .map((e, i) => ({ e, i, key: (e as { key: number }).key }))
      .sort((a, b) => a.key - b.key || a.i - b.i);
    const order: string[] = [];
    for (const e of fresh) {
      if (e.kind === 'batch') continue;
      if (e.createdAt !== undefined)
        while (batches.length && batches[0].key <= e.createdAt) order.push(batches.shift()!.e.opId);
      order.push(e.opId);
    }
    return [...claimed, ...order, ...batches.map((b) => b.e.opId)];
  }
  /** Batch requests not yet due, soonest first (bundle.json `scheduledQueue`). */
  scheduledQueue(head: string): BatchPublishPayload[] {
    return this.pendingRequests(head)
      .flatMap((e) => (e.kind === 'batch' && !e.due ? [e.payload] : []))
      .sort((a, b) => a.notBefore.localeCompare(b.notBefore) || a.opId.localeCompare(b.opId));
  }
  async verifyRequest(blob: string, opId: string, tree: Tree): Promise<PublishRequestPayload> {
    const envelope = JSON.parse(this.git.blob(blob));
    if (envelope.sourceIntent) {
      const payload = await verifyPreparedPublication(this, envelope, opId);
      const permissions = permissionsSchema.parse(this.read(tree, 'config/permissions.json'));
      if (!['maintainer', 'editor'].includes(permissions.users[String(payload.requester.id)]?.role))
        throw new Error('Requester revoked');
      requesterCredits(payload.requester);
      requireGlobalsMode(this, tree);
      return payload;
    }
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
    requesterCredits(p.requester);
    requireGlobalsMode(this, tree, p.kind === 'push' && !!p.globals);
    return p;
  }
  /** Recovery credits come from the signed envelope, never from an unverified log or receipt. */
  credits(blob: string, opId: string): CommitCredits {
    const envelope = JSON.parse(this.git.blob(blob));
    if (envelope.sourceIntent) {
      const { intent } = verifiedSource(this, envelope.sourceIntent);
      const payload = batchPublishPayloadSchema.parse(JSON.parse(envelope.payload));
      if (
        intent.kind !== 'schedule' ||
        intent.requestId !== opId ||
        payload.opId !== opId ||
        stableStringify(payload.requester) !== stableStringify(intent.requester) ||
        payload.batchId !== intent.batchId ||
        payload.notBefore !== intent.notBefore ||
        payload.contentRevision !== intent.contentRevision
      )
        throw new Error('Prepared credit identity mismatch');
      return requesterCredits(intent.requester);
    }
    const key = createPublicKey(this.options.publicKey);
    if (
      createHash('sha256')
        .update(key.export({ type: 'spki', format: 'der' }))
        .digest('hex') !== this.options.keyFingerprint ||
      typeof envelope.payload !== 'string' ||
      typeof envelope.sig !== 'string' ||
      !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.sig, 'base64'))
    )
      throw new Error('Invalid credit envelope');
    const raw = JSON.parse(envelope.payload);
    const payload =
      raw.kind === 'batch' ? batchPublishPayloadSchema.parse(raw) : publishPayloadSchema.parse(raw);
    if (
      stableStringify(payload) !== envelope.payload ||
      payload.opId !== opId ||
      payload.repo !== this.options.repo ||
      payload.dataBranch !== this.options.dataBranch ||
      payload.liveBranch !== this.options.liveBranch
    )
      throw new Error('Credit request target mismatch');
    return requesterCredits(payload.requester);
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
  mergePublicationPerks(
    sourceTree: Tree,
    live: Record<string, unknown>,
    entries: Receipt['exported'],
    hashes: Iterable<number>,
  ) {
    const aliases = this.aliasesAt(sourceTree);
    const raw = this.read<unknown>(sourceTree, aliasGroupsPath);
    const groups = raw === undefined ? undefined : { aliases, catalog: this.options.facts };
    const removed = raw === undefined ? undefined : aliasGroupsSchema.parse(raw).removed;
    return applyInactiveLive(
      mergeLivePerks(live, entries, this.pickRecomputeAt(sourceTree), groups, removed),
      this.movesAt(sourceTree),
      hashes,
      aliases,
      live,
    );
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
    let perks: Record<string, unknown>;
    let hasMoves: boolean;
    try {
      const sourceTree = this.git.tree(r.sourceCommit);
      if (sourceTree[aliasGroupsPath] && r.generatorSha !== this.options.generatorSha)
        throw new Error('Generator revision differs from frozen alias-group receipt');
      hasMoves = Object.keys(this.movesAt(sourceTree)).length > 0;
      const base = r.inPlace ? { ...live.perks } : live.perks;
      for (const hash of r.inPlace?.refills ?? []) {
        base[hash] = entries[hash];
        delete entries[hash];
      }
      perks =
        r.inPlace && !r.entries.length
          ? base
          : this.mergePublicationPerks(
              sourceTree,
              base,
              entries,
              r.entries.map((e) => e.hash),
            );
    } catch (error) {
      throw new ConsumerOutputRejected(String(error));
    }
    const merged = { ...live, perks };
    const bytes = json(merged);
    const { publisherSha, publisherDigest } = this.options;
    const pin = JSON.stringify([publisherSha, publisherDigest]);
    const presets = hasMoves
      ? [...deployedLegacyPresets, 'clarityV2' as const]
      : deployedLegacyPresets;
    const checkKey = createHash('sha256')
      .update(JSON.stringify([parent, pin, presets]))
      .update(bytes)
      .digest('hex');
    // Compare actual converter results for both snapshots. Only a previous result for this
    // exact parent and preset can stand in for the before conversion.
    if (this.checkedOutput?.key !== checkKey) {
      const candidate = this.candidateOutput;
      const before =
        candidate?.commit === parent && candidate.pin === pin ? candidate.after : undefined;
      const after = new Map<LegacyPreset, Set<string>>();
      for (const preset of presets) {
        const emptyRows = (input: unknown) => {
          try {
            const rows = JSON.parse(
              new TextDecoder().decode(buildLegacy(input as LegacyInput, preset)),
            ) as Record<string, { descriptions?: Record<string, unknown>; aliasOf?: number }>;
            return new Set(
              Object.entries(rows).flatMap(([hash, row]) =>
                row.aliasOf === undefined && Object.keys(row.descriptions ?? {}).length === 0
                  ? [hash]
                  : [],
              ),
            );
          } catch (error) {
            throw new ConsumerOutputRejected(`${preset} conversion failed: ${String(error)}`);
          }
        };
        const beforeEmpty = before?.get(preset) ?? emptyRows(live);
        let afterEmpty: Set<string>;
        try {
          afterEmpty = emptyRows(merged);
        } catch (error) {
          throw new ProposalOutputRejected(error instanceof Error ? error.message : String(error));
        }
        for (const hash of afterEmpty) {
          if (!beforeEmpty.has(hash))
            throw new TextlessConsumerOutput(
              `${preset} tooltip ${hash} has no descriptions; nothing published`,
            );
        }
        after.set(preset, afterEmpty);
      }
      this.checkedOutput = { key: checkKey, after };
    }
    return {
      bytes,
      outcome: bytes === this.git.blob(tree['liveDescriptions.json']) ? 'unchanged' : 'published',
    };
  }
  buildCandidate(parent: string, receipt: Receipt) {
    const { bytes, outcome } = this.merge(parent, receipt);
    const after = this.checkedOutput?.after;
    const r = { ...receipt, liveParent: parent, outcome };
    const tree = {
      ...this.git.tree(parent),
      'liveDescriptions.json': this.git.writeBlob(bytes),
      [paths(r.opId).receipt]: this.git.writeBlob(json(r)),
    };
    const candidate = this.git.commit(
      parent,
      tree,
      `Publish ${r.opId}`,
      this.credits(r.requestBlob, r.opId),
    );
    if (after) {
      const { publisherSha, publisherDigest } = this.options;
      this.candidateOutput = {
        commit: candidate,
        pin: JSON.stringify([publisherSha, publisherDigest]),
        after,
      };
    }
    return candidate;
  }
  private sourceAdvance(source: string, head: string, tree: Tree, opId: string, batch = false) {
    if (!this.git.ancestor(source, head)) return 'blocked';
    const reviewed = this.git.tree(source);
    const reviewedModes = this.git.treeModes?.(source);
    const currentModes = this.git.treeModes?.(head);
    // The commit writer reconstructs directories from tracked leaves. An explicit empty
    // subtree has its own Git identity and cannot be carried forward by that writer.
    if (
      Object.keys(reviewedModes ?? {}).some((path) => !Object.hasOwn(reviewed, path)) ||
      Object.keys(currentModes ?? {}).some((path) => !Object.hasOwn(tree, path))
    )
      return 'blocked';
    const regular = (modes: Record<string, string> | undefined, path: string) =>
      !modes || modes[path] === '100644';
    const nameProofRequest = (snapshot: Tree, path: string) => {
      const id = /^globals\/retries\/([0-9a-f-]{36})\.json$/.exec(path)?.[1];
      if (!id) return false;
      const request = nameProofRequestSchema.safeParse(this.read(snapshot, path));
      return request.success && request.data.id === id;
    };
    let rebuild = false;
    const acceptChange = (path: string) => {
      if (
        (Object.hasOwn(reviewed, path) && !regular(reviewedModes, path)) ||
        (Object.hasOwn(tree, path) && !regular(currentModes, path))
      )
        return false;
      // A concurrent staged Current save consumes its kick with the staged parts.
      if (batch && !tree[path]) {
        const staged = /^publish\/kicks\/current-save-([^/]+)\.json$/.exec(path)?.[1];
        if (
          staged &&
          publishOpIdSchema.safeParse(staged).success &&
          reviewed[currentSaveStagePaths.record(staged)]
        )
          return true;
      }
      const localized = /^(?:glossary|snippets)\/([^/]+)\.json$/.exec(path)?.[1];
      if (
        path === marksPath ||
        (localized !== 'en' && langSchema.safeParse(localized).success) ||
        /^exports\/projects\/[a-z0-9][a-z0-9-]*\.json$/.test(path) ||
        /^current-saves\/(?:[0-7][0-9A-HJKMNP-TV-Z]{25}\/(?:\d+|request|conflicts)|requesters\/\d+)\.json$/.test(
          path,
        )
      )
        return true;
      if (
        /^tooltips\/(?:0|[1-9]\d*)\.json$/.test(path) ||
        /^globals\/(?:layout\.json$|sync\.json$|catalog\.json$|(?:entries|causes|intents|names|reviews|projections|pages)\/)/.test(
          path,
        ) ||
        (reviewed[globalsInPlacePath] &&
          path === globalsReleasePaths.published(this.options.liveBranch)) ||
        derivedGlobalPath(path) ||
        path.startsWith('schedule/') ||
        [snippetsPath, inactiveMovesPath, aliasGroupsPath, sandboxPointersPath].includes(path)
      ) {
        rebuild = true;
        return true;
      }
      // A signed scheduled request can revalidate its whole plan against the new head.
      // Keep the same bookkeeping classification and never bypass the Git mode checks.
      if (batch) rebuild = true;
      return batch;
    };

    for (const [path, oid] of Object.entries(reviewed)) {
      if (!Object.hasOwn(tree, path)) {
        // A name-proof drain can consume its request while adding a clash proof.
        if (
          !(regular(reviewedModes, path) && nameProofRequest(reviewed, path)) &&
          !acceptChange(path)
        )
          return 'blocked';
      } else {
        if (
          currentModes &&
          (!Object.hasOwn(currentModes, path) || currentModes[path] !== reviewedModes?.[path])
        )
          return 'blocked';
        if (tree[path] !== oid && !acceptChange(path)) return 'blocked';
      }
    }
    for (const path of Object.keys(tree)) {
      if (Object.hasOwn(reviewed, path)) continue;
      if (!regular(currentModes, path)) return 'blocked';
      const request = /^publish\/requests\/([^/]+)\.json$/.exec(path)?.[1];
      const kick = /^publish\/kicks\/(?:batch-)?([^/]+)-[0-9]+\.json$/.exec(path)?.[1];
      const saveKick = /^publish\/kicks\/current-save-([^/]+)\.json$/.exec(path)?.[1];
      const log = /^publish\/log\/([^/]+)\/([^/.]+)(?:\.dup-[0-9]+)?\.json$/.exec(path);
      const queueAddition =
        (request !== opId && publishOpIdSchema.safeParse(request).success) ||
        publishOpIdSchema.safeParse(kick).success ||
        publishOpIdSchema.safeParse(saveKick).success ||
        /^publish\/kicks\/due-[0-9]{12}-[0-9]+\.json$/.test(path) ||
        (log &&
          log[2] !== opId &&
          publishOpIdSchema.safeParse(log[2]).success &&
          log[1] === publishMonth(log[2]));
      const clashProof =
        /^globals\/proofs\/clashes\/(?:exports|variables|titles)\/[0-9a-f]{64}\.json$/;
      if (
        !queueAddition &&
        !clashProof.test(path) &&
        !nameProofRequest(tree, path) &&
        !acceptChange(path)
      )
        return 'blocked';
    }
    return rebuild ? 'rebuild' : 'bookkeeping';
  }
  private releaseKey(requestBlob: string, data: string, live: string) {
    const { publisherSha, publisherDigest, generatorSha } = this.options;
    return JSON.stringify([requestBlob, data, live, publisherSha, publisherDigest, generatorSha]);
  }
  private assertRequestedDigests(
    entries: Entry[],
    hashes: number[],
    expected: (hash: number) => string | undefined,
    aliases: Aliases,
  ) {
    const markers = new Map(entries.map(({ hash, digest }) => [hash, digest]));
    if (markers.size !== entries.length)
      throw new ConsumerOutputRejected('Publication has duplicate markers');
    for (const hash of hashes) {
      const digest = expected(hash);
      if (!digest || markers.get(resolveAlias(hash, aliases)) !== digest)
        throw new ConsumerOutputRejected(
          `Tooltip ${hash} would publish a different revision than requested. Review the changes again.`,
        );
    }
  }
  private async verifyReceiptDigests(receipt: Receipt, atomic = false) {
    const frozen = this.git.tree(receipt.sourceCommit);
    const signed = await this.verifyRequest(receipt.requestBlob, receipt.opId, frozen);
    const options =
      receipt.generatorSha === this.options.generatorSha
        ? this.options
        : this.read<Options>(frozen, '.publisher/config.json');
    if (options?.generatorSha !== receipt.generatorSha)
      throw new ConsumerOutputRejected(
        'Missing pinned generator facts for the publication receipt',
      );
    const aliases = this.aliasesAt(frozen, options);
    const moves = this.movesAt(frozen);
    const pushed = pushedSchema.parse(this.read(frozen, 'live/pushed.json'));
    if (
      Boolean(frozen[globalsInPlacePath]) !== Boolean(receipt.inPlace) ||
      (receipt.inPlace && receipt.globals)
    )
      throw new ConsumerOutputRejected('Receipt does not match the reviewed shared text.');
    if (
      signed.intentDigest !== receipt.intentDigest ||
      stableStringify(signed.requester) !== stableStringify(receipt.requester)
    )
      throw new ConsumerOutputRejected('Receipt does not match the signed publication intent');
    if (
      !receipt.globals &&
      receipt.entries.length !==
        new Set(signed.hashes.map((hash) => resolveAlias(hash, aliases))).size
    )
      throw new ConsumerOutputRejected('Receipt does not match the requested rows');
    if (signed.kind === 'push') {
      if (!atomic || receipt.inPlace)
        this.assertRequestedDigests(
          receipt.entries,
          signed.hashes,
          (hash) => signed.expected[hash],
          aliases,
        );
    } else {
      const members = batchMembers(this, frozen, signed.batchId);
      if (
        signed.batchId !== receipt.batchId ||
        signed.contentRevision !== receipt.contentRevision ||
        stableStringify(members.map(({ hash }) => hash)) !== stableStringify(signed.hashes) ||
        (await approvedDigest(members)) !== signed.approvedDigest
      )
        throw new ConsumerOutputRejected('Batch receipt differs from the signed request');
      const expected = new Map<number, string>();
      const entries = new Map(receipt.entries.map((entry) => [entry.hash, entry]));
      for (const member of members) {
        const { hash } = member;
        const document = (prefix: string) => {
          const raw = this.read<unknown>(frozen, `${prefix}/${hash}.json`);
          return raw === undefined ? null : tooltipSchema.parse(raw);
        };
        const composed = this.composeMember(
          member,
          document('live/tooltips'),
          document('tooltips'),
          pushed[hash] !== undefined,
        );
        if (
          composed.status === 'stale' ||
          this.git.writeBlob(json(composed.tooltip)) !== entries.get(hash)?.tooltipBlob
        )
          throw new ConsumerOutputRejected(
            `Tooltip ${hash} differs from the approved batch composition`,
          );
        expected.set(hash, await inactivePublishableHash(composed.tooltip, aliases, moves));
      }
      this.assertRequestedDigests(
        receipt.entries,
        signed.hashes,
        (hash) => expected.get(hash),
        aliases,
      );
    }
    // Atomic RECORD checks these bytes against the approved composition at the current head.
    if (atomic && !receipt.inPlace) return;
    // Recovery verifies the frozen bytes independently of the receipt's claimed markers.
    try {
      const documents: Tooltip[] = [];
      for (const entry of receipt.entries) {
        const document = tooltipSchema.parse(JSON.parse(this.git.blob(entry.tooltipBlob)));
        if (
          document.hash !== entry.hash ||
          (await inactivePublishableHash(document, aliases, moves)) !== entry.digest
        )
          throw new Error(`Tooltip ${entry.hash} does not match its receipt marker`);
        if (signed.kind === 'push' && !receipt.globals) {
          const source =
            this.read<unknown>(frozen, `tooltips/${entry.hash}.json`) ??
            (isMovedInactive(entry.hash, moves)
              ? { hash: entry.hash, text: {}, associated: [] }
              : undefined);
          if (stableStringify(document) !== stableStringify(tooltipSchema.parse(source)))
            throw new Error(`Tooltip ${entry.hash} does not match the frozen source snapshot`);
        }
        documents.push(document);
      }
      const selected = selectedInactiveMoves(
        moves,
        documents.map(({ hash }) => hash),
        aliases,
      );
      const inPlace = this.inPlaceOptions(frozen, signed, receipt.liveParent);
      if (inPlace)
        assertInPlaceDocuments(
          documents.filter(({ hash }) => !isMovedInactive(hash, selected)),
          inPlace.options,
        );
      const exported = exportWithInactiveMoves(
        documents,
        receipt.now,
        options.facts,
        aliases,
        selected,
        inPlace && { globalsInPlace: inPlace.options },
      );
      if (inPlace && documents.length)
        provePublication(
          this,
          frozen,
          inPlace.live,
          documents,
          aliases,
          selected,
          receipt.now,
          exported,
          inPlace.options,
        );
      if (
        stableStringify({ ...inPlace?.refills, ...exported }) !==
          stableStringify(receipt.exported) ||
        stableStringify(inPlace ? this.inPlaceReceipt(inPlace, exported) : null) !==
          stableStringify(receipt.inPlace ?? null) ||
        stableStringify(
          receipt.entries
            .filter(({ hash, digest }) => pushed[hash] !== digest)
            .map(({ hash }) => hash),
        ) !== stableStringify(receipt.changed)
      )
        throw new Error('Publication receipt export or upload markers differ from its snapshots');
      return inPlace;
    } catch (error) {
      throw new ConsumerOutputRejected(String(error));
    }
  }
  async record(
    opId: string,
    receipt: Receipt | undefined,
    candidate: string | undefined,
    result?: { status: string; code?: 'selected-rows-changed'; error?: string; outcomes?: unknown },
    requestBlob?: string,
    landing?: Landing,
    atomicLive?: { parent: string; candidate: string; runtime?: Tree },
    failureHead?: string,
  ) {
    const p = paths(opId);
    const inPlace = receipt && (await this.verifyReceiptDigests(receipt, atomicLive !== undefined));
    for (let i = 0; i < 5; i++) {
      const h = this.head(this.options.dataBranch),
        tree = this.git.tree(h);
      if (tree[p.log]) return;
      if (
        receipt &&
        (Boolean(tree[globalsInPlacePath]) !== Boolean(receipt.inPlace) ||
          (receipt.inPlace &&
            tree[globalsInPlacePath] !== this.git.tree(receipt.sourceCommit)[globalsInPlacePath]))
      )
        throw new ConsumerOutputRejected('Publication is fenced by a different shared text mode.');
      if (failureHead && failureHead !== h) throw new RefRace('Batch refusal source moved');
      // An admitted save keeps the publication opId but withdraws its ready envelope.
      // A late rejection must never tombstone it or remove the preparation's due kick.
      if (
        !receipt &&
        new SchedulePreparer(this)
          .batches(tree)
          .some(
            (batch) =>
              batch.opId === opId && ['preparing', 'needs_attention'].includes(batch.status),
          )
      )
        return;
      if (atomicLive) {
        if (receipt?.batchId && !this.git.casMany)
          throw new Error('Atomic scheduled publication is unavailable');
        if (!receipt || !this.git.casMany)
          throw new ConsumerOutputRejected('Atomic globals publication is unavailable');
        const source = receipt.sourceCommit;
        if (receipt.batchId) {
          this.assertBatchRuntime(tree, atomicLive.runtime);
          const path = schedulePaths.batch(receipt.batchId);
          if (tree[p.request] !== receipt.requestBlob) return;
          if (tree[path] !== this.git.tree(source)[path]) {
            const batch = batchSchema.safeParse(this.read(tree, path)).data;
            if (batch?.opId !== opId) throw new ConsumerOutputRejected(supersededMessage);
            throw new ConsumerOutputRejected('The batch changed after publishing started.');
          }
        }
        const signed = await this.verifyRequest(receipt.requestBlob, opId, tree).catch((error) => {
          if (receipt.batchId)
            throw new ConsumerOutputRejected(
              error instanceof Error ? error.message : String(error),
            );
          throw error;
        });
        if (receipt.inPlace && tree[p.request] !== receipt.requestBlob)
          throw new ConsumerOutputRejected(
            'Publication changed before landing; review the tooltip again.',
          );
        const liveMoved =
          signed.kind === 'batch' &&
          i > 0 &&
          this.head(this.options.liveBranch) !== atomicLive.parent;
        if (source !== h || liveMoved) {
          const advance = this.sourceAdvance(source, h, tree, opId, signed.kind === 'batch');
          if (advance === 'blocked' && signed.kind === 'batch')
            throw new RefRace('Claimed batch source no longer matches its publication fence');
          if (advance === 'blocked')
            throw new ConsumerOutputRejected('Global receipt identity mismatch');
          if (advance === 'rebuild' || liveMoved)
            throw new SourceAdvanced(
              atomicLive.candidate,
              receipt.requestBlob,
              source,
              h,
              signed.hashes,
              signed.kind === 'batch',
            );
        }
        if (!receipt.inPlace) {
          let documents: Tooltip[] | undefined;
          let entryOnlyAggregates: number[] = [];
          if (signed.kind === 'batch') {
            const plan = await this.batchPlan(
              tree,
              signed,
              this.aliasesAt(tree),
              source,
              atomicLive.parent,
            );
            if (
              'failure' in plan ||
              stableStringify(plan.globals ?? null) !== stableStringify(receipt.globals ?? null)
            )
              throw new ConsumerOutputRejected('Scheduled global receipt identity mismatch');
            documents = plan.entries.map((entry) =>
              tooltipSchema.parse(JSON.parse(this.git.blob(entry.tooltipBlob))),
            );
          } else {
            const reviewed = this.reviewedRelease;
            const release = await new GlobalsPublisher(this).validate(
              receipt.globals,
              tree,
              source,
              atomicLive.parent,
              source === h &&
                reviewed?.key === this.releaseKey(receipt.requestBlob, h, atomicLive.parent)
                ? reviewed.release
                : undefined,
            );
            documents = release?.documents;
            entryOnlyAggregates = release?.entryOnlyAggregates ?? [];
          }
          if (
            !documents ||
            ((signed.kind === 'push' || receipt.globals) &&
              stableStringify(signed.hashes) !== stableStringify(receipt.globals?.roots)) ||
            stableStringify(signed.requester) !== stableStringify(receipt.requester) ||
            receipt.publisherSha !== this.options.publisherSha ||
            receipt.generatorSha !== this.options.generatorSha
          )
            throw new ConsumerOutputRejected('Global receipt identity mismatch');
          const aliases = this.aliasesAt(tree);
          if (signed.kind === 'push')
            this.assertRequestedDigests(
              receipt.entries,
              signed.hashes.filter(
                (hash) => !entryOnlyAggregates.includes(resolveAlias(hash, aliases)),
              ),
              (hash) => signed.expected[hash],
              aliases,
            );
          const moves = selectedInactiveMoves(
            this.movesAt(tree),
            documents.map((document) => document.hash),
            aliases,
          );
          const exported = exportWithInactiveMoves(
            documents,
            receipt.now,
            this.options.facts,
            aliases,
            moves,
          );
          if (
            stableStringify(exported) !== stableStringify(receipt.exported) ||
            documents.length !== receipt.entries.length
          )
            throw new ConsumerOutputRejected(
              receipt.globals
                ? 'Global receipt export mismatch'
                : 'Publication receipt export mismatch',
            );
          for (const document of documents) {
            const entry = receipt.entries.find((entry) => entry.hash === document.hash);
            if (
              !entry ||
              entry.digest !== (await inactivePublishableHash(document, aliases, moves)) ||
              stableStringify(document) !==
                stableStringify(JSON.parse(this.git.blob(entry.tooltipBlob)))
            )
              throw new ConsumerOutputRejected('Global receipt dependency mismatch');
          }
          const markers = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
          if (
            stableStringify(
              receipt.entries
                .filter((entry) => markers[entry.hash] !== entry.digest)
                .map((entry) => entry.hash),
            ) !== stableStringify(receipt.changed)
          )
            throw new ConsumerOutputRejected('Global receipt upload marker mismatch');
        }
      }
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
      // commit (spec "Publication path" 6), computed from the receipt and this RECORD snapshot.
      const batchTimes = batchPayload
        ? this.recordBatch(tree, opId, batchPayload, receipt, candidate, result, landing)
        : undefined;
      if (receipt) {
        const pushed = pushedSchema.parse(this.read(tree, 'live/pushed.json'));
        if (inPlace && receipt.inPlace?.globals.length) {
          rewritePushed(this, tree, pushed, inPlace.rewritten);
          for (const [hash, tooltip] of inPlace.rewritten)
            tree[`live/tooltips/${hash}.json`] = this.git.writeBlob(json(tooltip));
          tree[globalsReleasePaths.published(this.options.liveBranch)] = this.git.writeBlob(
            json(inPlace.published),
          );
        }
        for (const e of receipt.entries) {
          pushed[e.hash] = e.digest;
          tree[`live/tooltips/${e.hash}.json`] = e.tooltipBlob;
        }
        tree['live/pushed.json'] = this.git.writeBlob(json(pushed));
        if (receipt.globals) {
          await new GlobalsPublisher(this).record(tree, receipt.globals, h, candidate!);
        }
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
      let credits = appCredits;
      if (receipt) credits = this.credits(blob, opId);
      else {
        try {
          credits = this.credits(blob, opId);
        } catch {
          /* Unverified rejection is app-only; successful recovery must retain its author. */
        }
      }
      // Globals materialization and validation can take a full minute. Stamp each atomic
      // attempt only after that work, when sealing the commit that will be pushed.
      if (atomicLive && batchPayload && batchTimes) {
        const landedAt = iso(this.options.now());
        const path = schedulePaths.batch(batchPayload.batchId);
        const batch = batchSchema.parse(this.read(tree, path));
        if (batch.result?.status === 'published') {
          batch.result.landedAt = landedAt;
          batch.result.landedAtSource = 'cas';
          tree[path] = this.git.writeBlob(json(batch));
        }
        batchTimes.landedAt = landedAt;
        batchTimes.landedAtSource = 'cas';
      }
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
            ...(receipt?.inPlace?.globals.length ? { globals: receipt.inPlace.globals } : {}),
            ...(receipt?.inPlace?.refusals?.length
              ? { globalRefusals: receipt.inPlace.refusals }
              : {}),
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
      const c = this.git.commit(h, tree, `Record ${opId}`, credits);
      try {
        if (atomicLive)
          this.git.casMany!([
            { ref: dataRef(this.options.dataBranch), old: h, next: c },
            {
              ref: dataRef(this.options.liveBranch),
              old: atomicLive.parent,
              next: atomicLive.candidate,
            },
          ]);
        else this.git.cas(dataRef(this.options.dataBranch), h, c);
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
      let credits = appCredits;
      try {
        credits = this.credits(t[p.request], opId);
      } catch {
        /* A forged or malformed duplicate has no verified requester. */
      }
      delete t[p.request];
      try {
        this.git.cas(
          dataRef(this.options.dataBranch),
          h,
          this.git.commit(h, t, `Close duplicate ${opId}`, credits),
        );
        return;
      } catch (e) {
        if (!(e instanceof RefRace)) throw e;
      }
    }
    throw new Error('Duplicate closure raced');
  }
  async operation(
    opId: string,
    runtime = this.git.tree(this.head(this.options.dataBranch)),
  ): Promise<void> {
    const p = paths(opId);
    let rebuilding: SourceAdvanced | undefined;
    for (let attempt = 0; ; attempt++) {
      let s = this.head(this.options.dataBranch);
      let tree = this.git.tree(s);
      try {
        if (rebuilding && !tree[p.log]) {
          if (rebuilding.batch && !tree[p.request]) return;
          if (
            tree[p.request] !== rebuilding.requestBlob ||
            (s !== rebuilding.head &&
              this.sourceAdvance(rebuilding.head, s, tree, opId, rebuilding.batch) === 'blocked')
          )
            throw new RefRace('Manual publish source no longer matches the retry fence');
          const checked = await new GlobalsPublisher(this).drain(s);
          const materialized = this.git.tree(checked);
          const previous = this.git.tree(rebuilding.source);
          const paths = new Set([...Object.keys(previous), ...Object.keys(tree)]);
          const sources = publicationSourcesPath(this.options.liveBranch);
          if (
            tree[sources] &&
            tree[sources] === materialized[sources] &&
            [...paths].some(
              (path) =>
                derivedGlobalPath(path) &&
                previous[path] !== tree[path] &&
                tree[path] !== materialized[path],
            )
          )
            throw new NamedPartRefusal(
              `Could not verify the global proofs for ${this.partNames(previous, rebuilding.hashes)}. Nothing in this part went live. Review before publishing again.`,
            );
          s = this.head(this.options.dataBranch);
          tree = this.git.tree(s);
          if (
            s !== checked &&
            !tree[p.log] &&
            this.sourceAdvance(checked, s, tree, opId, rebuilding.batch) !== 'bookkeeping'
          )
            throw new RefRace('Manual publish source moved after sync');
        }
        return await this.publishOperation(opId, s, tree, runtime, rebuilding);
      } catch (error) {
        if (error instanceof SourceAdvanced && attempt < 2) {
          rebuilding = error;
          continue;
        }
        if (rebuilding && error instanceof RefRace) {
          const landed = this.receipt(this.head(this.options.liveBranch), opId);
          if (
            landed?.requestBlob === rebuilding.requestBlob &&
            this.git.tree(this.head(this.options.dataBranch))[p.log]
          )
            return;
          if (attempt < 2) continue;
        }
        if (!(error instanceof ConsumerOutputRejected)) throw error;
        const live = this.head(this.options.liveBranch);
        const pending = this.git.head(p.candidate);
        if (this.receipt(live, opId) || (pending && this.git.ancestor(pending, live)))
          throw new Error('Publication already landed. Operator required to finish RECORD.', {
            cause: error,
          });
        // A terminal content refusal closes the signed request without changing LIVE.
        await this.record(
          opId,
          undefined,
          undefined,
          error instanceof NamedPartRefusal
            ? {
                status: 'rejected',
                code: 'selected-rows-changed',
                error: error.message,
                outcomes: error.outcomes,
              }
            : { status: 'rejected', error: String(error) },
          tree[p.request],
          undefined,
          undefined,
          rebuilding?.batch ? s : undefined,
        );
        try {
          if (pending) this.git.cas(p.candidate, pending, undefined);
        } catch {
          /* A terminal Record is authoritative; candidate cleanup is best effort. */
        }
        return;
      }
    }
  }
  private assertBatchRuntime(tree: Tree, runtime?: Tree) {
    const paths = ['PIN', 'config.json', 'publisher.mjs', 'verify-publication.mjs'].map(
      (name) => `.publisher/${name}`,
    );
    if (runtime && paths.some((path) => tree[path] !== runtime[path]))
      throw new RefRace('Publisher installation changed during this run');
    if (
      this.options.publisherConfigDigest &&
      (!tree[paths[1]] ||
        createHash('sha256').update(this.git.blob(tree[paths[1]])).digest('hex') !==
          this.options.publisherConfigDigest)
    )
      throw new RefRace('Wait for the installed publisher configuration to run');
    if (tree[paths[0]] || this.options.publisherConfigDigest) {
      const pin = this.read<{ sourceSha: string; sha256: string }>(tree, paths[0]);
      if (
        pin?.sourceSha !== this.options.publisherSha ||
        (this.options.publisherDigest && pin.sha256 !== this.options.publisherDigest)
      )
        throw new RefRace('Wait for the installed publisher to run');
    }
  }
  private partNames(previous: Tree, hashes: readonly number[], current: Tooltip[] = []) {
    return [
      ...new Set(
        hashes.map(
          (hash) =>
            current.find((tooltip) => tooltip.hash === hash)?.custom?.name ||
            this.read<Tooltip>(previous, `tooltips/${hash}.json`)?.custom?.name ||
            this.options.facts[hash]?.name ||
            `Tooltip ${hash}`,
        ),
      ),
    ].join(', ');
  }
  private async publishOperation(
    opId: string,
    s: string,
    tree: Tree,
    runtime: Tree,
    rebuilding?: SourceAdvanced,
  ): Promise<void> {
    const p = paths(opId);
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
    let candidate = this.candidate(opId, blob);
    if (rebuilding && !candidate) throw new RefRace('Publish candidate moved');
    if (candidate?.r.batchId) {
      this.assertBatchRuntime(tree, runtime);
      const { c, r } = candidate;
      if (
        c !== rebuilding?.candidate &&
        (r.publisherSha !== this.options.publisherSha ||
          r.generatorSha !== this.options.generatorSha ||
          r.verifierSha256 !== this.options.verifierDigest)
      )
        throw new SourceAdvanced(
          c,
          blob,
          r.sourceCommit,
          s,
          r.globals?.roots ?? r.entries.map(({ hash }) => hash),
          true,
        );
    }
    if (!candidate || candidate.c === rebuilding?.candidate) {
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
          {
            status: 'rejected',
            error: `Invalid alias configuration (${sandboxPointersPath}, ${aliasGroupsPath}): ${String(e)}`,
          },
          blob,
        );
        return;
      }
      if (payload.kind === 'batch') {
        this.assertBatchRuntime(tree, runtime);
        const r = await this.claimBatch(opId, blob, s, tree, live, payload, aliases);
        if (!r) {
          if (candidate && this.git.tree(this.head(this.options.dataBranch))[p.log]) {
            try {
              this.git.cas(p.candidate, candidate.c, undefined);
            } catch {
              /* The terminal log owns the result. */
            }
          }
          return;
        }
        candidate = this.createCandidate(opId, blob, live, r, rebuilding?.candidate);
      } else {
        const moves = this.movesAt(tree);
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
          const tooltip = tooltipSchema.safeParse(
            oid
              ? JSON.parse(this.git.blob(oid))
              : isMovedInactive(canonical, moves)
                ? { hash: canonical, text: {}, associated: [] }
                : undefined,
          );
          if (!tooltip.success || tooltip.data.hash !== canonical) {
            outcomes.push({ hash: canonical, status: 'missing' });
            continue;
          }
          const digest = await inactivePublishableHash(tooltip.data, aliases, moves);
          outcomes.push({
            hash: canonical,
            status: digest === payload.expected[hash] ? 'accepted' : 'stale',
          });
          if (!seen.has(canonical)) {
            entries.push({
              hash: canonical,
              digest,
              tooltipBlob: oid ?? this.git.writeBlob(json(tooltip.data)),
            });
            tooltips.push(tooltip.data);
            seen.add(canonical);
          }
        }
        if (outcomes.some((e) => e.status !== 'accepted')) {
          if (rebuilding) {
            const previous = this.git.tree(rebuilding.source);
            const hashes = outcomes
              .filter(({ status }) => status !== 'accepted')
              .map(({ hash }) => hash);
            const guidance = outcomes.some(({ status }) => status === 'accepted')
              ? 'The other rows in this part also stayed unpublished. You can publish them again.'
              : 'Nothing in this part went live. Review the changed text before publishing again.';
            throw new NamedPartRefusal(
              `Saved text changed after review for ${this.partNames(previous, hashes, tooltips)}. ${guidance}`,
              outcomes,
            );
          }
          await this.record(opId, undefined, undefined, { status: 'stale', outcomes }, blob);
          return;
        }
        let globals: GlobalReleaseReceipt | undefined;
        let entryOnlyAggregates: number[] = [];
        if (hasGlobals(tree) && !tree[globalsInPlacePath]) {
          try {
            const release = await new GlobalsPublisher(this).release(tree, s, payload.hashes, live);
            if (!release) throw new Error('Missing global release');
            this.reviewedRelease = {
              key: this.releaseKey(blob, s, live),
              release: structuredClone(release),
            };
            globals = release.receipt;
            entryOnlyAggregates = release.entryOnlyAggregates;
            tooltips.splice(0, tooltips.length, ...release.documents);
            entries.splice(
              0,
              entries.length,
              ...(await Promise.all(
                release.documents.map(async (tooltip) => ({
                  hash: tooltip.hash,
                  digest: await inactivePublishableHash(tooltip, aliases, moves),
                  tooltipBlob: this.git.writeBlob(json(tooltip)),
                })),
              )),
            );
          } catch (error) {
            throw new ConsumerOutputRejected(
              error instanceof GlobalReleaseRejected
                ? error.message
                : 'Sync pending: global dependency review required',
            );
          }
        }
        this.assertRequestedDigests(
          entries,
          payload.hashes.filter(
            (hash) => !entryOnlyAggregates.includes(resolveAlias(hash, aliases)),
          ),
          (hash) => payload.expected[hash],
          aliases,
        );
        const inPlace = this.inPlaceOptions(tree, payload, live);
        const checked = this.checkAndExport(tree, tooltips, aliases, inPlace);
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
          ...(this.options.verifierDigest ? { verifierSha256: this.options.verifierDigest } : {}),
          outcome: 'published',
          entries,
          exported: { ...inPlace?.refills, ...checked.exported },
          changed: entries
            .filter(({ hash, digest }) => pushed[hash] !== digest)
            .map(({ hash }) => hash),
          requester: payload.requester,
          intentDigest: payload.intentDigest,
          ...(globals ? { globals } : {}),
          ...(inPlace ? { inPlace: this.inPlaceReceipt(inPlace, checked.exported) } : {}),
        };
        candidate = this.createCandidate(opId, blob, live, r, rebuilding?.candidate);
      }
    }
    let rebases = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      candidate = this.candidate(opId, blob);
      if (!candidate) {
        const landed = this.receipt(this.head(this.options.liveBranch), opId);
        if (
          landed?.opId === opId &&
          landed.requestBlob === blob &&
          this.git.tree(this.head(this.options.dataBranch))[p.log]
        )
          return;
        throw new Error('Candidate disappeared');
      }
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
      try {
        const mode = requireGlobalsMode(this, this.git.tree(this.head(this.options.dataBranch)));
        if (Boolean(mode) !== Boolean(r.inPlace)) throw new Error('Publication mode changed.');
      } catch (error) {
        throw new ConsumerOutputRejected(String(error));
      }
      if (l === r.liveParent) {
        // A candidate may predate this safety gate; validate it again before any live CAS.
        const checked = this.merge(l, r);
        const candidateBytes = this.git.blob(this.git.tree(c)['liveDescriptions.json']);
        if (candidateBytes !== checked.bytes)
          throw new ConsumerOutputRejected(
            'stored candidate differs from its checked receipt; nothing published',
          );
        if (
          r.batchId ||
          r.globals ||
          r.inPlace ||
          hasGlobals(this.git.tree(this.head(this.options.dataBranch)))
        ) {
          try {
            await this.record(
              opId,
              r,
              c,
              undefined,
              undefined,
              { at: this.options.now(), source: 'cas' },
              { parent: l, candidate: c, ...(r.batchId ? { runtime } : {}) },
            );
          } catch (error) {
            if (
              r.batchId ||
              error instanceof RefRace ||
              error instanceof SourceAdvanced ||
              error instanceof ConsumerOutputRejected
            )
              throw error;
            throw new ConsumerOutputRejected(
              'Global publication changed or requires recovery; nothing partially published',
            );
          }
          try {
            this.git.cas(p.candidate, c, undefined);
          } catch {
            /* best effort */
          }
          return;
        }
        await this.verifyReceiptDigests(r);
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
        if (r.inPlace) {
          const head = this.head(this.options.dataBranch);
          throw new SourceAdvanced(
            c,
            blob,
            r.sourceCommit,
            head,
            r.entries.map(({ hash }) => hash),
            !!r.batchId,
          );
        }
        if (r.batchId && r.globals) {
          const head = this.head(this.options.dataBranch);
          if (
            this.sourceAdvance(r.sourceCommit, head, this.git.tree(head), opId, true) !== 'blocked'
          )
            throw new SourceAdvanced(c, blob, r.sourceCommit, head, r.globals.roots, true);
        }
        if (r.globals || hasGlobals(this.git.tree(this.head(this.options.dataBranch))))
          throw new ConsumerOutputRejected('Global live inputs changed; review publication again');
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
    inPlace?: { live: LegacyInput; options: GlobalsInPlaceOptions },
  ):
    | { error: string; proposalRejected?: true; retryable?: true }
    | { now: number; exported: ReturnType<typeof exportLegacy> } {
    const moves = selectedInactiveMoves(
      this.movesAt(tree),
      tooltips.map((t) => t.hash),
      aliases,
    );
    const active = tooltips.filter((t) => !isMovedInactive(t.hash, moves));
    if (active.some(isTextlessDescription))
      return { error: 'Tooltip has no text to publish', proposalRejected: true };
    try {
      this.checkAssociatedDescriptions(tree, active, aliases);
    } catch (error) {
      return { error: String(error), retryable: true };
    }
    if (active.some((t) => !t.custom && !this.options.facts[t.hash]))
      return { error: 'Missing generator facts', retryable: true };
    // The data head can advance after the Worker signs. In particular, stale
    // translation fallback can hide raw native markup from publishableHash.
    // Reject it terminally instead of letting exportLegacy wedge the queue.
    if (
      active.some((tooltip) =>
        Object.values(tooltip.text).some((translation) => translation?.text.includes('{{')),
      )
    )
      return { error: baseEnhancedPublishMessage, proposalRejected: true };
    // Set bonuses wait for cut-over (owner 2026-11-11): a terminal rejection before any write.
    if (active.some((t) => isHeldSetBonus(t, this.options.facts[t.hash])))
      return { error: setBonusHoldMessage, proposalRejected: true };
    const now = this.options.now();
    let exported: ReturnType<typeof exportLegacy>;
    try {
      if (inPlace) assertInPlaceDocuments(active, inPlace.options);
      exported = exportWithInactiveMoves(
        tooltips,
        now,
        this.options.facts,
        aliases,
        moves,
        inPlace && { globalsInPlace: inPlace.options },
      );
      if (inPlace && tooltips.length)
        provePublication(
          this,
          tree,
          inPlace.live,
          tooltips,
          aliases,
          moves,
          now,
          exported,
          inPlace.options,
        );
    } catch (error) {
      if (inPlace) return { error: String(error), proposalRejected: true };
      throw new ConsumerOutputRejected(String(error));
    }
    // Fail closed: exportLegacy lowers element-tagged text to today's `<solar/>Scorch`, and
    // `#{d}` and `<enhanced/>` to `#d` and `#e`. An export that still holds a tagged span, a
    // preview marker, `#{`, or `<enhanced/>` would make apps drop text or print the markup.
    const unlowered = unloweredEntry(exported);
    if (unlowered !== undefined)
      return {
        error: `The export of tooltip ${unlowered} still holds unlowered markup`,
        proposalRejected: true,
      };
    return { now, exported };
  }
  private inPlaceOptions(tree: Tree, payload: PublishRequestPayload, live: string) {
    try {
      const selection = payload.kind === 'push' ? (payload.globals ?? []) : [];
      const fence = requireGlobalsMode(this, tree, selection.length > 0);
      if (!fence) return;
      this.assertBatchRuntime(tree);
      const pin = this.read<{ capabilities: string[] }>(tree, '.publisher/PIN');
      if (!pin?.capabilities.includes(globalsInPlaceCapability))
        throw new Error('Update the installed publisher before publishing shared text.');
      assertInPlaceRoots(payload.hashes);
      if (!this.git.ancestor(fence.migratedLive, live))
        throw new Error('LIVE has no in-place migration.');
      const input = liveGlobalsInput(this, live);
      assertInPlaceLibraries(input);
      const role = permissionsSchema.parse(this.read(tree, 'config/permissions.json')).users[
        payload.requester.id
      ]?.role;
      const plan = planInPlaceRelease(
        this,
        tree,
        input,
        selection,
        role === 'maintainer',
        payload.hashes.length > 0,
      );
      return {
        ...plan,
        live: { ...input, perks: { ...input.perks, ...plan.refills } as LegacyInput['perks'] },
      };
    } catch (error) {
      throw new ConsumerOutputRejected(String(error));
    }
  }
  private inPlaceReceipt(
    plan: ReturnType<typeof planInPlaceRelease>,
    exported: Receipt['exported'],
  ) {
    return {
      globals: plan.globals,
      refills: Object.keys(plan.refills)
        .filter((hash) => !exported[hash])
        .map(Number),
      ...(plan.refusals.length ? { refusals: plan.refusals } : {}),
    };
  }
  createCandidate(opId: string, blob: string, live: string, r: Receipt, previous?: string) {
    const p = paths(opId);
    const c = this.buildCandidate(live, r);
    let candidate: ReturnType<Publisher['candidate']>;
    for (let i = 0; i < 6 && !candidate; i++) {
      try {
        this.git.cas(p.candidate, previous, c);
      } catch {
        /* ambiguous: always read back */
      }
      candidate = this.candidate(opId, blob);
      if (candidate?.c === previous) candidate = undefined;
    }
    if (!candidate && previous) throw new RefRace('Replacement candidate moved');
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
    revision = this.head(this.options.dataBranch),
    live = this.head(this.options.liveBranch),
  ): Promise<
    | { failure: Failure }
    | {
        entries: Entry[];
        now: number;
        exported: ReturnType<typeof exportLegacy>;
        changed: number[];
        globals?: GlobalReleaseReceipt;
        inPlace?: Receipt['inPlace'];
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
    const outcomes: BatchOutcome[] = [];
    const tooltips: Tooltip[] = [];
    const moves = this.movesAt(tree);
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
      if (await hasUnpublishedInactiveMove(m.hash, snapshot, pushed[m.hash], aliases, moves)) {
        outcomes.push({ hash: m.hash, status: 'stale', reason: unreviewedInactiveMessage });
        continue;
      }
      // Non-translation merge3 against current (translations follow Q4 and never block).
      const activation = activate({ base: m.base, current, proposed: m.proposed });
      if (!activation.ok) {
        outcomes.push({
          hash: m.hash,
          status: 'stale',
          fields: activation.fields,
          ...(activation.reason ? { reason: activation.reason } : {}),
        });
        continue;
      }
      const composed = this.composeMember(m, snapshot, current, pushed[m.hash] !== undefined);
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
    let documents = tooltips;
    let globals: GlobalReleaseReceipt | undefined;
    const prepared = this.read<PreparedPublication>(tree, paths(payload.opId).request);
    if (!hasGlobals(tree) && prepared?.sourceIntent) {
      const source = verifiedSource(this, prepared.sourceIntent);
      if (hasGlobals(source.tree))
        return {
          failure: {
            status: 'rejected',
            error:
              'Global metadata was removed after scheduling; return to draft and schedule again',
            globals: true,
          },
        };
    }
    if (hasGlobals(tree) && !tree[globalsInPlacePath]) {
      try {
        new SchedulePreparer(this).pin(tree);
        const pin = this.read<{ capabilities: string[] }>(tree, '.publisher/PIN');
        if (!pin?.capabilities.includes('scheduledGlobalsV1'))
          throw new Error('The installed publisher does not support scheduled globals yet');
        if (members.some((member) => member.hash === 1 || member.hash === 2 || member.hash === 3))
          throw new Error('Use global entry mutations instead of scheduled aggregate edits');
        const envelope = prepared;
        if (!envelope?.sourceIntent)
          throw new Error('Scheduled globals require a signed preparation source; schedule again');
        const source = verifiedSource(this, envelope.sourceIntent);
        const release = await new GlobalsPublisher(this).release(
          tree,
          revision,
          payload.hashes,
          live,
          {
            source: source.intent.sourceCommit,
            documents: tooltips,
          },
        );
        documents = release!.documents;
        globals = release!.receipt;
      } catch (error) {
        return {
          failure: {
            status: 'rejected',
            error: error instanceof Error ? error.message : String(error),
            globals: true,
          },
        };
      }
    }
    let inPlace;
    try {
      inPlace = this.inPlaceOptions(tree, payload, live);
    } catch (error) {
      return { failure: { status: 'rejected', error: String(error) } };
    }
    const checked = this.checkAndExport(tree, documents, aliases, inPlace);
    if ('error' in checked) return { failure: { status: 'rejected', ...checked } };
    const entries: Entry[] = [];
    for (const tooltip of documents)
      entries.push({
        hash: tooltip.hash,
        digest: await inactivePublishableHash(tooltip, aliases, moves),
        tooltipBlob: this.git.writeBlob(json(tooltip)),
      });
    if (globals) {
      const expected = new Map(
        await Promise.all(
          tooltips.map(
            async (tooltip) =>
              [tooltip.hash, await inactivePublishableHash(tooltip, aliases, moves)] as const,
          ),
        ),
      );
      try {
        this.assertRequestedDigests(entries, payload.hashes, (hash) => expected.get(hash), aliases);
      } catch (error) {
        if (!(error instanceof ConsumerOutputRejected)) throw error;
        return { failure: { status: 'rejected', error: error.message } };
      }
    }
    return {
      entries,
      now: checked.now,
      exported: checked.exported,
      changed: entries
        .filter(({ hash, digest }) => pushed[hash] !== digest)
        .map(({ hash }) => hash),
      ...(inPlace ? { inPlace: this.inPlaceReceipt(inPlace, checked.exported) } : {}),
      ...(globals ? { globals } : {}),
    };
  }
  /**
   * compose() for one member (C1-C4), with the stamps of English and the Bungie snapshot taken
   * from activation: when current already holds the batch's content for such a field, merge3's
   * stamped rule keeps current's stamps in RECORD, so live takes them too and equals a manual
   * publish of the activated tooltip (CONSUMER OUTPUT byte identity). Content always comes from
   * the proposal (a clean activation has the proposal's content in every non-translation changed
   * field); translations take the upcoming entry, then source stamps are bounded against final
   * English exactly as in activation. `current` is the
   * saved tooltip at the snapshot the claim validated (S, equal to S' outside schedule/).
   */
  composeMember(
    m: BatchMember,
    snapshot: Tooltip | null,
    current: Tooltip | null,
    pushed: boolean,
  ): ReturnType<typeof compose> {
    // English stamps are selected below; bounding earlier can age a translation of the final
    // (convergent) English against the proposal's older revision.
    const result = compose(
      { hash: m.hash, base: m.base, proposed: m.proposed, snapshot, pushed },
      false,
    );
    if (result.status === 'stale') return result;
    const activation = activate({ base: m.base, current, proposed: m.proposed });
    let tooltip = result.tooltip;
    if (activation.ok)
      for (const field of result.changed)
        if (field === 'text.en' || field === 'bungieSnapshot')
          tooltip = withField(tooltip, activation.tooltip, field);
    return { ...result, tooltip: boundTranslationSources(tooltip) };
  }
  /** S' for a batch this opId already claimed: the oldest commit of the head's claimed run. */
  claimCommit(batchId: string, opId: string, head = this.head(this.options.dataBranch)): string {
    // Only the claim commit sets `claim` (opIds are unique) and it stays until RECORD ends the
    // operation, so the commits claimed by this opId are one suffix of first-parent history:
    // binary search finds its first commit in O(log n) tree reads, however long the outage.
    const commits = this.git.history(head);
    const claimedAt = (i: number) =>
      batchSchema.safeParse(
        this.read<unknown>(this.git.tree(commits[i]), schedulePaths.batch(batchId)),
      ).data?.claim?.opId === opId;
    let unclaimed = 0,
      claimed = commits.length - 1;
    // Fail closed unless the boundary is proven: an unclaimed first commit, a claimed head.
    if (claimed < 1 || !claimedAt(claimed) || claimedAt(unclaimed))
      throw new Error('Claim commit not found; operator required');
    while (claimed - unclaimed > 1) {
      const mid = (unclaimed + claimed) >> 1;
      if (claimedAt(mid)) claimed = mid;
      else unclaimed = mid;
    }
    return commits[claimed];
  }
  /**
   * Validate at S, then CLAIM (spec "Publication path" 4, I2): one CAS S → S' marks the batch
   * publishing and its due entry claimed. A race or an ambiguous CAS returns to run(), which
   * re-reads the head and the queue order (a request admitted meanwhile may now come first) and
   * re-validates from the top. A batch this opId already claimed (a run died after the claim)
   * resumes from S' and drains before any other request. Returns the frozen receipt, or
   * undefined once the operation is handled or left for the next queue pass.
   */
  async claimBatch(
    opId: string,
    blob: string,
    s: string,
    tree: Tree,
    live: string,
    payload: BatchPublishPayload,
    aliases: Aliases,
  ): Promise<Receipt | undefined> {
    const path = schedulePaths.batch(payload.batchId);
    const parsed = batchSchema.safeParse(this.read<unknown>(tree, path));
    const claimed =
      parsed.data?.status === 'publishing' &&
      parsed.data.opId === opId &&
      parsed.data.claim?.opId === opId;
    const fail = async (failure: Failure) => {
      const { status, error, outcomes } = failure;
      await this.record(
        opId,
        undefined,
        undefined,
        { status, error, outcomes },
        blob,
        undefined,
        undefined,
        claimed ? s : undefined,
      );
      return undefined;
    };
    if (!parsed.success)
      return fail({ status: 'rejected', error: 'Missing or invalid batch.json' });
    const batch = parsed.data;
    if (batch.opId === opId && ['preparing', 'needs_attention'].includes(batch.status)) return;
    if (
      batch.opId !== opId ||
      (batch.status !== 'scheduled' && !claimed) ||
      batch.scheduledContentRevision !== payload.contentRevision ||
      batch.contentRevision !== payload.contentRevision ||
      batch.notBefore !== payload.notBefore
    )
      return fail({ status: 'superseded', error: supersededMessage });
    const envelope = JSON.parse(this.git.blob(blob)) as Partial<PreparedPublication>;
    if (!claimed && Date.parse(payload.notBefore) > this.options.now()) return;
    if (
      batch.preparedRequestId != null ||
      envelope.preparedRequestId != null ||
      envelope.sourceIntent
    ) {
      if (
        (!claimed && !canClaimPreparedBatch(batch, envelope.preparedRequestId ?? '')) ||
        (claimed &&
          (batch.preparation ||
            !batch.preparedRequestId ||
            batch.preparedRequestId !== envelope.preparedRequestId))
      )
        return fail({ status: 'rejected', error: 'Batch preparation ready fence mismatch' });
      try {
        new SchedulePreparer(this).pin(tree);
        const checked = verifiedRequest(
          this,
          tree,
          scheduleIntentPaths.request(batch.preparedRequestId!),
        );
        if (checked.request.status !== 'completed' || checked.intent.batchId !== batch.id)
          throw new Error('Preparation result does not authorize this batch');
        if (checked.intent.kind === 'save') {
          const result = new SchedulePreparer(this).validateSave(tree, checked);
          for (const member of result.written) {
            const accepted = this.read<BatchMember>(
              tree,
              schedulePaths.member(batch.id, member.hash),
            );
            if (stableStringify(accepted?.proposed) !== stableStringify(member.proposed))
              throw new Error('Accepted translations differ from prepared signed save');
          }
        } else if (
          checked.intent.requestId !== payload.opId ||
          stableStringify(checked.request.envelope) !== stableStringify(envelope.sourceIntent)
        )
          throw new Error('Prepared schedule approval mismatch');
      } catch (error) {
        return fail({ status: 'rejected', error: String(error) });
      }
    }
    const claim = claimed ? this.claimCommit(payload.batchId, opId, s) : s;
    if (claim !== s) {
      const frozen = this.git.tree(claim);
      const prefix = `schedule/batches/${batch.id}/tooltips/`;
      const modes = this.git.treeModes?.(s);
      if (Object.keys(modes ?? {}).some((name) => !Object.hasOwn(tree, name)))
        throw new RefRace('Cannot preserve an empty Git tree during publication');
      if (
        tree[path] !== frozen[path] ||
        blob !== frozen[paths(opId).request] ||
        Object.keys(frozen).some(
          (name) => name.startsWith(prefix) && tree[name] !== frozen[name],
        ) ||
        Object.keys(tree).some((name) => name.startsWith(prefix) && !frozen[name])
      )
        return fail({ status: 'rejected', error: 'The batch changed after publishing started.' });
    }
    const plan = await this.batchPlan(tree, payload, aliases, s, live);
    if ('failure' in plan) {
      if (plan.failure.globals && !claimed && batch.preparedRequestId) {
        await new SchedulePreparer(this).drain(true);
        const latest = batchSchema.parse(
          this.read(this.git.tree(this.head(this.options.dataBranch)), path),
        );
        if (latest.opId === opId && latest.status === 'needs_attention') return;
      }
      const { failure } = plan;
      if (claimed && failure.status === 'stale' && failure.outcomes?.length) {
        const affected = failure.outcomes.filter(({ status }) => status !== 'accepted');
        const names = this.partNames(
          this.git.tree(claim),
          affected.map(({ hash }) => hash),
          batchMembers(this, tree, payload.batchId).map(({ proposed }) => proposed),
        );
        return fail({
          ...failure,
          error: `Current changes conflict with the scheduled changes for ${names}. Edit the batch before scheduling again.`,
        });
      }
      return fail(failure);
    }
    const receipt: Receipt = {
      opId,
      requestBlob: blob,
      sourceCommit: s,
      liveParent: live,
      now: plan.now,
      publisherSha: this.options.publisherSha,
      generatorSha: this.options.generatorSha,
      ...(this.options.verifierDigest ? { verifierSha256: this.options.verifierDigest } : {}),
      outcome: 'published',
      entries: plan.entries,
      exported: plan.exported,
      changed: plan.changed,
      requester: payload.requester,
      intentDigest: payload.intentDigest,
      batchId: payload.batchId,
      contentRevision: payload.contentRevision,
      ...(plan.globals ? { globals: plan.globals } : {}),
      ...(plan.inPlace ? { inPlace: plan.inPlace } : {}),
    };
    // A refused batch must not leave even a claim commit behind.
    this.merge(live, receipt);
    let sourceCommit = s;
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
      const c = this.git.commit(
        s,
        next,
        `Claim batch ${batch.id} for ${opId}`,
        this.credits(blob, opId),
      );
      try {
        this.git.cas(dataRef(this.options.dataBranch), s, c);
        sourceCommit = c;
      } catch {
        // RefRace (a Worker write won) or ambiguous (it may have landed: then the batch is
        // claimed and drains first): run() re-reads the queue and re-validates from the top.
        return undefined;
      }
    }
    if (receipt.globals && sourceCommit !== s) {
      // CLAIM changes only scheduling metadata. Rebind the head-bound release certificate
      // to S' while preserving the immutable signed dependency pin.
      const frozen = await this.batchPlan(
        this.git.tree(sourceCommit),
        payload,
        aliases,
        sourceCommit,
        live,
      );
      if ('failure' in frozen)
        throw new ConsumerOutputRejected(frozen.failure.error ?? 'Scheduled global claim changed');
      receipt.globals = frozen.globals;
    }
    return { ...receipt, sourceCommit };
  }
  /**
   * The batch part of RECORD at head `tree` (edited in place). With a landed receipt: activation
   * per member (base and proposed from the receipt's snapshot, current from this head),
   * conflict files for legacy landed receipts, and the published batch. A refused claim needs
   * attention. An unclaimed refusal still returns to draft while this opId owns it (R15).
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
        const attention = batch.status === 'publishing' && status !== 'superseded';
        const updated = withEvent(
          this,
          tree,
          batch,
          {
            status: attention ? 'needs_attention' : 'draft',
            preparedRequestId: null,
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
    if (
      receipt.globals &&
      stableStringify(receipt.globals.roots) !== stableStringify(payload.hashes)
    )
      throw new Error('Global batch receipt roots differ from its signed members');
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
        memberHashes: payload.hashes,
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
    const ref = dataRef('editor-data-bundle');
    let old = this.git.head(ref);
    for (let attempt = 0; ; attempt++) {
      try {
        return this.bundleAt(ref, old);
      } catch (error) {
        if (!(error instanceof RefRace) || attempt === 2) throw error;
        const current = this.git.head(ref);
        if (!current || current === old || (old && !this.git.ancestor(old, current))) throw error;
        old = current;
      }
    }
  }
  private bundleAt(ref: string, old: string | undefined) {
    const h = this.head(this.options.dataBranch),
      t = this.git.tree(h),
      oldTree = old ? this.git.tree(old) : {};
    const fence = globalsFence(this, t);
    if (fence?.state === 'hold') return;
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
        return {
          opId: id,
          requester: p.requester,
          hashes: p.hashes,
          createdAt: p.createdAt,
          ...(p.globals ? { globals: p.globals.map(({ id }) => id) } : {}),
        };
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
    let inactiveMoves: InactiveMoves | undefined;
    try {
      if (t[inactiveMovesPath]) inactiveMoves = this.movesAt(t);
    } catch {
      // Invalid JSON and invalid shapes must not wedge terminal rejection or bundle refresh.
    }
    const inPlace = fence && bundleInPlaceReview(this, t, fence);
    const bundle = {
      sourceCommit: h,
      generatedAt: new Date(this.options.now()).toISOString(),
      tooltips,
      permissions: permissionsSchema.parse(this.read(t, 'config/permissions.json')),
      pushed: inPlace?.pushed ?? pushedSchema.parse(this.read(t, 'live/pushed.json')),
      // Preserve malformed config too: omitting it would resurrect archived members in readers.
      // Raw invalid JSON becomes null, which the web schema rejects, without wedging the queue.
      ...(t[aliasGroupsPath]
        ? {
            aliasGroups: (() => {
              try {
                return this.read<unknown>(t, aliasGroupsPath);
              } catch {
                return null;
              }
            })(),
          }
        : {}),
      ...(inactiveMoves ? { inactiveMoves } : {}),
      ...(sandboxPointers && Object.keys(sandboxPointers.pointers).length
        ? { sandboxPointers }
        : {}),
      publishQueue,
      ...(scheduledQueue.length ? { scheduledQueue } : {}),
      ...(inPlace ? { globalsPending: inPlace.globalsPending } : {}),
      // The globals catalogue at this same head; null (never a partial list) when malformed,
      // so the editor says it is unavailable without stopping the bundle or the queue.
      ...(hasGlobals(t)
        ? {
            globals: (() => {
              try {
                return bundleGlobals(t, (tree, path) => this.read<unknown>(tree, path));
              } catch {
                return null;
              }
            })(),
          }
        : {}),
    };
    // The publisher owns only bundle.json: every other file on the bundle branch (the report
    // catalogs report-items*.json, rebuilt by the pipeline's report-items job) is carried
    // forward byte-identical, so no bundle push can delete them.
    const c = this.git.commit(
      old,
      { ...oldTree, 'bundle.json': this.git.writeBlob(json(bundle)) },
      `Bundle ${h}`,
      appCredits,
    );
    this.git.cas(ref, old, c);
  }
  async run(syncGlobals = true) {
    const start = this.options.now();
    const runtime = this.git.tree(this.head(this.options.dataBranch));
    if (globalsFence(this, runtime)?.state === 'hold') return;
    try {
      if (syncGlobals) {
        await drainCurrentSaves(this);
        await new SchedulePreparer(this).drain();
        await new GlobalsPublisher(this).drain();
      }
      await new SchedulePreparer(this).drain(true);
      if (this.queue(this.head(this.options.dataBranch)).length) this.bundle();
      for (let n = 0; n < 20 && this.options.now() - start < 20 * 60_000; n++) {
        const [id] = this.queue(this.head(this.options.dataBranch));
        if (!id) break;
        await this.operation(id, runtime);
      }
    } finally {
      this.bundle();
    }
  }
}
