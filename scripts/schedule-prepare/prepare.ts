import { z } from 'zod';
import {
  hashSchema,
  permissionsSchema,
  pushedSchema,
  resolveAlias,
  stableStringify,
} from '@clarity/core';
import {
  batchSchema,
  draftStagingInputSchema,
  dueSchema,
  isContentChange,
  isOpenStatus,
  matchesPreparationFence,
  preparedDraftSave,
  scheduleIntentPaths,
  schedulePaths,
  scheduleIndexEntry,
  scheduleIndexSchema,
  scheduleLimits,
  type Batch,
  type ScheduleIntent,
  type ScheduleRequest,
  scheduleIntentSchema,
  scheduleRequestSchema,
  scheduledStagingSchema,
} from '@clarity/core/schedule';
import {
  batchSaveChangeSchema,
  validateBatchSave,
  validateScheduleMembers,
} from '../../apps/worker/src/schedule/validation.js';
import { HttpError } from '../../apps/worker/src/http.js';
import type { RepoFile } from '../../apps/worker/src/github.js';
import { scheduledSaveChangeCap } from '../../apps/worker/src/schedule/store.js';
import { appCredits, RefRace, type Tree } from '../publisher/git.js';
import { batchMembers, json, iso, withEvent } from '../publisher/batch.js';
import {
  ConsumerOutputRejected,
  ProposalOutputRejected,
  paths,
  type Publisher,
} from '../publisher/publisher.js';
import { hasGlobals } from '../publisher/globals.js';
import {
  publication,
  schedulePayload,
  verifiedRequest,
  InvalidScheduleIntent,
  type PreparedPublication,
} from './intents.js';

class PreparationRejected extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
/** Only a known rejection of submitted edits may exercise keep_scheduled. */
class ProposalRejected extends PreparationRejected {}
const saveInput = z
  .object({
    requestId: z.string(),
    revision: z.number().int().nonnegative(),
    changes: z
      .array(batchSaveChangeSchema)
      .min(1)
      .refine((changes) => new Set(changes.map((c) => c.hash)).size === changes.length),
    message: z.string().trim().min(1).max(500),
    draftStaging: draftStagingInputSchema.optional(),
  })
  .strict();
function reject(message: string): never {
  throw new PreparationRejected(message);
}

/** Offline only. Every read is at one head; all accepted members and outcomes share one CAS. */
export class SchedulePreparer {
  constructor(readonly pub: Publisher) {}
  file(tree: Tree, path: string): RepoFile | null {
    return tree[path] ? { sha: tree[path], value: this.pub.read(tree, path) } : null;
  }
  access(tree: Tree, id: number) {
    const access = permissionsSchema.parse(this.pub.read(tree, 'config/permissions.json')).users[
      String(id)
    ];
    if (!access || !['maintainer', 'editor', 'translator'].includes(access.role))
      throw new ProposalRejected('Requester revoked');
    return access!;
  }
  pin(tree: Tree) {
    const pin = z
      .object({ sourceSha: z.string(), sha256: z.string(), capabilities: z.array(z.string()) })
      .parse(this.pub.read(tree, '.publisher/PIN'));
    if (
      pin.sourceSha !== this.pub.options.publisherSha ||
      pin.sha256 !== this.pub.options.publisherDigest ||
      !pin.capabilities.includes('scheduledBatches') ||
      !pin.capabilities.includes('schedulePreparationV1')
    )
      reject('Installed publisher lacks matching schedulePreparationV1 PIN');
    return pin;
  }
  /** Also reused at claim to recheck current save authorization against its signed source. */
  validateSave(tree: Tree, checked: ReturnType<typeof verifiedRequest>) {
    const { intent, batch, members } = checked;
    if (intent.kind !== 'save') return reject('Expected a signed save');
    const inputResult = saveInput.safeParse(checked.input);
    if (!inputResult.success) throw new ProposalRejected('Invalid batch save proposal');
    const input = inputResult.data;
    const access = this.access(tree, intent.requester.id);
    if (intent.draftStaging && access.role === 'translator')
      throw new ProposalRejected('Draft batch staging requires an editing role');
    const own = new Set(members.map((m) => m.hash));
    const adds = input.changes.filter((c) => !own.has(c.hash));
    if (!intent.scheduledParts && input.changes.length > preparedDraftSave.changes)
      throw new ProposalRejected('Too many batch save changes');
    if (
      intent.returnStatus === 'scheduled' &&
      !intent.scheduledParts &&
      input.changes.length > scheduledSaveChangeCap
    )
      throw new ProposalRejected('Too many scheduled save changes');
    if (adds.length && (access.role === 'translator' || batch.status !== 'draft'))
      throw new ProposalRejected('Unschedule to add batch members');
    const aliases = this.pub.aliasesAt(tree);
    const others = this.batches(tree).filter(
      (other) => other.id !== batch.id && isOpenStatus(other.status),
    );
    for (const { hash } of input.changes) {
      if (resolveAlias(hash, aliases) !== hash)
        throw new ProposalRejected(`Tooltip ${hash} is an alias`);
      for (const other of others) {
        if (tree[schedulePaths.member(other.id, hash)])
          throw new ProposalRejected(`Tooltip ${hash} already belongs to open batch ${other.id}`);
      }
    }
    const scheduled = batch.status === 'scheduled';
    const files = [
      ...input.changes.map(({ hash }) =>
        this.file(
          own.has(hash) ? checked.tree : tree,
          own.has(hash) ? schedulePaths.member(batch.id, hash) : `tooltips/${hash}.json`,
        ),
      ),
      ...input.changes.map(({ hash }) => this.file(tree, `tooltips/${hash}.json`)),
      ...(scheduled
        ? input.changes.map(({ hash }) => this.file(tree, `live/tooltips/${hash}.json`))
        : []),
    ];
    let result: ReturnType<typeof validateBatchSave>;
    try {
      result = validateBatchSave({
        batch,
        batchId: batch.id,
        input,
        own,
        files,
        ...(scheduled
          ? {
              pushed: new Set(
                Object.keys(pushedSchema.parse(this.pub.read(tree, 'live/pushed.json'))).map(
                  Number,
                ),
              ),
            }
          : {}),
        pin: { value: this.pin(tree) },
        access,
        now: iso(this.pub.options.now()),
        user: intent.requester,
        head: intent.sourceCommit,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status < 500)
        throw new ProposalRejected(error.message, error.details);
      throw error;
    }
    if (result.conflicts.length)
      throw new ProposalRejected('Conflicting batch save', result.conflicts);
    return result;
  }
  batches(tree: Tree): Batch[] {
    return Object.keys(tree)
      .filter((p) => /^schedule\/batches\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/batch\.json$/.test(p))
      .sort()
      .map((p) => {
        const batch = batchSchema.parse(this.pub.read(tree, p));
        if (p !== schedulePaths.batch(batch.id)) reject('Stored batch identity mismatch');
        return batch;
      });
  }
  refreshIndex(tree: Tree) {
    const entries = this.batches(tree).map((b) =>
      scheduleIndexEntry(
        b,
        // Advisory membership comes from names, not member bodies that validation may
        // just have rejected. Failure outcomes must still be able to commit.
        b.memberHashes ??
          Object.keys(tree).flatMap((path) => {
            const prefix = `schedule/batches/${b.id}/tooltips/`;
            if (!path.startsWith(prefix)) return [];
            const name = path.slice(prefix.length);
            if (!/^(0|[1-9]\d*)\.json$/.test(name)) return [];
            const hash = hashSchema.safeParse(Number(name.slice(0, -5)));
            return hash.success ? [hash.data] : [];
          }),
        b.events.at(-1)?.at ?? b.createdAt,
      ),
    );
    if (!entries.length && !tree[schedulePaths.index]) return;
    const terminal = entries
      .filter((b) => !isOpenStatus(b.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const keep = new Set(terminal.slice(0, scheduleLimits.indexTerminal).map((b) => b.id));
    const index = scheduleIndexSchema.parse({
      batches: entries.filter((b) => isOpenStatus(b.status) || keep.has(b.id)),
    });
    // Legacy Worker writes moved the updated entry to the end. Preserve an
    // equivalent index byte-for-byte on idle drains, regardless of that order.
    let oldIndex: unknown;
    try {
      oldIndex = this.pub.read(tree, schedulePaths.index);
    } catch (error) {
      // This advisory blob may be invalid JSON. Rebuild it from authoritative
      // batches, but keep surfacing repository/read failures.
      if (!(error instanceof SyntaxError)) throw error;
    }
    const previous = scheduleIndexSchema.safeParse(oldIndex);
    if (
      previous.success &&
      stableStringify({
        batches: [...previous.data.batches].sort((a, b) => a.id.localeCompare(b.id)),
      }) === stableStringify(index)
    )
      return;
    tree[schedulePaths.index] = this.pub.writeBlob(`${JSON.stringify(index)}\n`);
  }
  collision(tree: Tree, opId: string) {
    if (tree[paths(opId).request] || tree[paths(opId).log])
      reject('Publication operation ID already exists');
  }
  original(tree: Tree, checked: ReturnType<typeof verifiedRequest>) {
    const original = this.pub.read<PreparedPublication>(
      tree,
      scheduleIntentPaths.publication(checked.batch.id),
    );
    const source = this.pub.read<unknown>(checked.tree, paths(checked.batch.opId!).request);
    if (!original || stableStringify(source) !== stableStringify(original))
      reject('Withdrawn publication identity mismatch');
    return original!;
  }
  async validatePublication(
    tree: Tree,
    payload: Awaited<ReturnType<typeof schedulePayload>>,
    head: string,
  ) {
    this.pin(tree);
    const members = batchMembers(this.pub, tree, payload.batchId);
    if (!members.length) reject('Invalid scheduled batch member count');
    const others = this.batches(tree).filter(
      (batch) => batch.id !== payload.batchId && isOpenStatus(batch.status),
    );
    for (const member of members) {
      for (const other of others)
        if (tree[schedulePaths.member(other.id, member.hash)])
          reject(`Tooltip ${member.hash} already belongs to open batch ${other.id}`);
    }
    const pushed = new Set(
      Object.keys(pushedSchema.parse(this.pub.read(tree, 'live/pushed.json'))).map(Number),
    );
    validateScheduleMembers(
      members.map((m) => m.hash),
      members.flatMap((m) => [
        this.file(tree, schedulePaths.member(payload.batchId, m.hash)),
        this.file(tree, `tooltips/${m.hash}.json`),
        this.file(tree, `live/tooltips/${m.hash}.json`),
        this.file(tree, schedulePaths.conflict(m.hash)),
      ]),
      pushed,
    );
    const plan = await this.pub.batchPlan(tree, payload, this.pub.aliasesAt(tree));
    if ('failure' in plan) {
      const Rejection = plan.failure.proposalRejected
        ? ProposalRejected
        : plan.failure.retryable
          ? ConsumerOutputRejected
          : PreparationRejected;
      throw new Rejection(plan.failure.error ?? plan.failure.status, plan.failure.outcomes);
    }
    // Exercise the actual consumer converter before announcing that the batch is ready.
    const live = this.pub.head(this.pub.options.liveBranch);
    this.pub.merge(live, {
      ...plan,
      opId: payload.opId,
      requestBlob: '',
      sourceCommit: head,
      liveParent: live,
      publisherSha: this.pub.options.publisherSha,
      generatorSha: this.pub.options.generatorSha,
      outcome: 'published',
      requester: payload.requester,
      intentDigest: payload.intentDigest,
    });
  }
  async prepare(
    tree: Tree,
    head: string,
    batch: Batch,
    request: ScheduleRequest,
    checked: ReturnType<typeof verifiedRequest>,
  ) {
    const { intent } = checked;
    if (!this.pub.git.ancestor(intent.sourceCommit, head))
      reject('Schedule source is not in data branch history');
    if (
      intent.batchId !== batch.id ||
      batch.contentRevision !== intent.contentRevision ||
      batch.preparation?.kind !== intent.kind ||
      batch.preparation.returnStatus !==
        (intent.kind === 'schedule' ? 'scheduled' : intent.returnStatus)
    )
      reject('Preparation intent or content fence mismatch');
    // Admission cannot mutate accepted members; a later Retry must keep this exact source.
    const currentMembers = batchMembers(this.pub, tree, batch.id);
    for (const m of currentMembers)
      if (
        tree[schedulePaths.member(batch.id, m.hash)] !==
        checked.tree[schedulePaths.member(batch.id, m.hash)]
      )
        reject('Accepted members changed during preparation');
    if (currentMembers.length !== checked.members.length)
      reject('Accepted membership changed during preparation');
    const access = this.access(tree, intent.requester.id);
    this.pin(tree);
    const staging = intent.kind === 'save' ? intent.draftStaging : undefined;
    if (
      staging &&
      (batch.draftStaging?.id !== staging.id || batch.draftStaging.ownerId !== intent.requester.id)
    )
      reject('Draft batch staging changed during preparation');
    let contentChanged = false;
    let stagedHashes: number[] | undefined;
    if (intent.kind === 'save') {
      const result = this.validateSave(tree, checked);
      contentChanged = isContentChange(result.before, result.written);
      if (intent.returnStatus === 'scheduled' && contentChanged) reject('Unschedule to edit');
      if (staging) stagedHashes = result.written.map(({ hash }) => hash);
      for (const m of result.written)
        tree[schedulePaths.member(batch.id, m.hash)] = this.pub.writeBlob(json(m));
    } else if (!['maintainer', 'editor'].includes(access.role)) reject('Scheduling role revoked');
    const scheduled = batch.preparation!.returnStatus === 'scheduled';
    let ready: string | null = null;
    if (scheduled) {
      let envelope: unknown;
      if (intent.kind === 'schedule') {
        if (
          batch.opId !== intent.requestId ||
          batch.notBefore !== intent.notBefore ||
          batch.zone !== intent.zone
        )
          reject('Schedule target changed');
        envelope = publication(
          await schedulePayload(this.pub, request.envelope),
          request.envelope,
          request.requestId,
        );
      } else {
        const original = this.original(tree, checked);
        // The legacy signed batch wire format stays valid for schedules admitted before activation.
        envelope = { ...original, preparedRequestId: request.requestId };
      }
      this.collision(tree, batch.opId!);
      const payload = await this.pub.verifyRequest(
        this.pub.writeBlob(json(envelope)),
        batch.opId!,
        tree,
      );
      if (
        payload.kind !== 'batch' ||
        payload.batchId !== batch.id ||
        payload.contentRevision !== batch.contentRevision ||
        payload.notBefore !== batch.notBefore
      )
        reject('Publication approval identity mismatch');
      tree[paths(batch.opId!).request] = this.pub.writeBlob(json(envelope));
      await this.validatePublication(tree, payload, head);
      ready = request.requestId;
    }
    const at = iso(this.pub.options.now());
    const updated = withEvent(
      this.pub,
      tree,
      batch,
      {
        status: scheduled ? 'scheduled' : 'draft',
        preparation: null,
        preparedRequestId: ready,
        contentRevision: batch.contentRevision + Number(contentChanged),
        scheduledContentRevision: scheduled ? batch.contentRevision : null,
        ...(staging?.finish ? { draftStaging: undefined } : {}),
      },
      {
        action: 'prepared',
        by: intent.requester,
        at,
        hashes: stagedHashes ?? batchMembers(this.pub, tree, batch.id).map((m) => m.hash),
      },
    );
    tree[schedulePaths.batch(batch.id)] = this.pub.writeBlob(json(updated));
    tree[scheduleIntentPaths.request(request.requestId)] = this.pub.writeBlob(
      json({
        ...request,
        status: 'completed',
        updatedAt: at,
        retryable: false,
        reasons: [],
        ...(this.pub.options.runUrl.startsWith('https://')
          ? { workflowUrl: this.pub.options.runUrl }
          : {}),
        result: {
          revision: updated.revision,
          contentRevision: updated.contentRevision,
          status: updated.status,
        },
      }),
    );
    this.refreshDue(tree);
  }
  /** due is only a trigger: derive it from the authoritative states after materialization. */
  refreshDue(tree: Tree) {
    tree[schedulePaths.due] = this.pub.writeBlob(
      json(
        dueSchema.parse({
          entries: this.batches(tree)
            .filter(
              (batch) =>
                batch.opId &&
                batch.notBefore &&
                (batch.status === 'scheduled' ||
                  batch.status === 'publishing' ||
                  (batch.status === 'preparing' &&
                    batch.preparation?.returnStatus === 'scheduled')),
            )
            .map((batch) => ({
              batchId: batch.id,
              opId: batch.opId!,
              notBefore: batch.notBefore!,
              claimed: batch.claim?.opId === batch.opId,
            })),
        }),
      ),
    );
  }
  async failure(
    tree: Tree,
    batch: Batch,
    request: ScheduleRequest,
    error: unknown,
    checked?: ReturnType<typeof verifiedRequest>,
  ) {
    const semantic =
      error instanceof PreparationRejected ||
      error instanceof ProposalOutputRejected ||
      error instanceof InvalidScheduleIntent ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error instanceof HttpError && error.status < 500);
    const at = iso(this.pub.options.now());
    const reason =
      (error instanceof Error ? error.message : String(error)).slice(0, 2000) ||
      'Preparation failed';
    const details =
      error instanceof PreparationRejected || error instanceof HttpError
        ? error.details
        : undefined;
    const parsed = z
      .array(
        z.object({
          hash: z.number().int().nonnegative().max(0xffffffff),
          fields: z.array(z.string().max(100)).max(100).optional(),
          reason: z.string().optional(),
        }),
      )
      .safeParse(
        Array.isArray(details) ? details : (details as { members?: unknown } | undefined)?.members,
      );
    const reasons: NonNullable<ScheduleRequest['reasons']> =
      parsed.success && parsed.data.length
        ? parsed.data
            .slice(0, 100)
            .map((r) => ({ ...r, reason: (r.reason ?? reason).slice(0, 2000) }))
        : [{ reason }];
    const draftFailed =
      semantic && checked?.intent.kind === 'save' && checked.intent.draftStaging !== undefined;
    let restored = false;
    let update: Partial<Batch> = draftFailed
      ? { status: 'draft', preparation: null }
      : { status: 'needs_attention' };
    // Only a VERIFIED owner policy and a known proposal rejection may restore an old schedule.
    if (
      (error instanceof ProposalRejected || error instanceof ProposalOutputRejected) &&
      checked?.intent.kind === 'save' &&
      checked.intent.onValidationFailure === 'keep_scheduled'
    ) {
      try {
        const source = checked.batch;
        const original = this.original(tree, checked);
        this.collision(tree, source.opId!);
        const payload = await this.pub.verifyRequest(
          this.pub.writeBlob(json(original)),
          source.opId!,
          tree,
        );
        if (
          payload.kind !== 'batch' ||
          payload.batchId !== batch.id ||
          payload.contentRevision !== source.contentRevision ||
          payload.notBefore !== source.notBefore ||
          batch.opId !== source.opId ||
          batch.notBefore !== source.notBefore
        )
          reject('Cannot restore superseded publication');
        tree[paths(source.opId!).request] = this.pub.writeBlob(json(original));
        update = {
          status: 'scheduled',
          preparation: null,
          preparedRequestId: source.preparedRequestId ?? null,
          opId: source.opId,
          notBefore: source.notBefore,
          zone: source.zone,
          scheduledContentRevision: source.scheduledContentRevision,
        };
        restored = true;
      } catch (restoreError) {
        // The rejected proposal stays durable, but it cannot poison every other
        // batch and manual publication when its old approval is no longer usable.
        if (reasons.length === 100) reasons.pop();
        reasons.push({
          reason:
            `Accepted schedule could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`.slice(
              0,
              2000,
            ),
        });
      }
    }
    const updated = withEvent(
      this.pub,
      tree,
      batch,
      {
        ...update,
        lastPreparationFailure: { requestId: request.requestId, at, reason },
      },
      { at, by: checked?.intent.requester ?? batch.createdBy, action: 'preparation_failed' },
    );
    tree[schedulePaths.batch(batch.id)] = this.pub.writeBlob(json(updated));
    const { result: _result, ...record } = request;
    void _result;
    tree[scheduleIntentPaths.request(request.requestId)] = this.pub.writeBlob(
      json({
        ...record,
        status: restored || draftFailed ? 'failed' : 'needs_attention',
        retryable: !semantic,
        updatedAt: at,
        reasons,
        ...(this.pub.options.runUrl.startsWith('https://')
          ? { workflowUrl: this.pub.options.runUrl }
          : {}),
      }),
    );
    this.refreshDue(tree);
  }
  async drain(readyOnly = false) {
    const ref = `refs/heads/${this.pub.options.dataBranch}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = this.pub.head(this.pub.options.dataBranch),
        tree = this.pub.git.tree(head);
      const original = { ...tree };
      // Only outstanding requests are relevant; retained terminal evidence and *.body.json
      // never enter enumeration, regardless of the size of the request history.
      const requests = this.batches(tree)
        .filter(() => !readyOnly)
        .filter((b) => b.status === 'preparing' && b.preparation)
        .map((b) => scheduleIntentPaths.request(b.preparation!.requestId))
        .sort();
      for (const path of requests) {
        const record = this.pub.read<unknown>(tree, path);
        const request = scheduleRequestSchema.parse(record);
        if (request.status !== 'pending') continue;
        const batch = batchSchema.parse(this.pub.read(tree, schedulePaths.batch(request.batchId)));
        if (!matchesPreparationFence(batch, request)) continue;
        let checked: ReturnType<typeof verifiedRequest> | undefined;
        let next = { ...tree };
        try {
          checked = verifiedRequest(this.pub, tree, path);
          await this.prepare(next, head, batch, request, checked);
        } catch (error) {
          next = { ...tree }; // Never commit even one member of a rejected save.
          await this.failure(next, batch, request, error, checked);
        }
        // Recheck at the exact CAS base, including all rejection/restoration paths.
        const current = batchSchema.parse(this.pub.read(tree, schedulePaths.batch(batch.id)));
        if (!matchesPreparationFence(current, request)) continue;
        Object.assign(tree, next);
      }
      let recheckedReady = false;
      const currentGlobals = hasGlobals(tree);
      // A data push can change a dependency long before notBefore. Do not leave an
      // obsolete ready fence looking scheduled until the due-time claim discovers it.
      for (const batch of this.batches(tree).filter((batch) => batch.status === 'scheduled')) {
        if (!batch.preparedRequestId) continue;
        const path = scheduleIntentPaths.request(batch.preparedRequestId);
        if (!currentGlobals) {
          // Discovery only: a positive match below still requires the complete signed
          // request. Legacy no-globals work keeps its existing claim-time validation.
          let pinnedGlobals = false;
          try {
            const recorded = this.pub.read<ScheduleRequest>(tree, path);
            const source: unknown = JSON.parse(recorded?.envelope.payload ?? 'null')?.sourceCommit;
            if (typeof source === 'string' && /^[a-f0-9]{40}$/.test(source))
              pinnedGlobals = hasGlobals(this.pub.git.tree(source));
          } catch {
            // Malformed legacy evidence cannot authorize a claim; leave its old path intact.
          }
          if (!pinnedGlobals) continue;
        }
        // The signed source remains authoritative if the entire current namespace
        // disappears. Legacy no-globals schedules retain their existing behavior.
        recheckedReady = true;
        let request: ScheduleRequest | undefined;
        let intent: ScheduleIntent | undefined;
        let checked: ReturnType<typeof verifiedRequest> | undefined;
        try {
          request = scheduleRequestSchema.parse(this.pub.read(tree, path));
          intent = scheduleIntentSchema.parse(JSON.parse(request.envelope.payload));
          checked = verifiedRequest(this.pub, tree, path);
          if (checked.intent.batchId !== batch.id) reject('Ready request belongs to another batch');
          const raw = this.pub.read<PreparedPublication>(tree, paths(batch.opId!).request);
          const payload = await this.pub.verifyRequest(
            this.pub.writeBlob(json(raw)),
            batch.opId!,
            tree,
          );
          if (payload.kind !== 'batch') reject('Scheduled publication identity mismatch');
          await this.validatePublication(tree, payload, head);
        } catch (error) {
          // Preserve malformed/foreign evidence for the existing claim-time refusal.
          // Never invent a request or overwrite another batch's audit to report failure.
          if (
            !request ||
            !intent ||
            request.requestId !== batch.preparedRequestId ||
            request.batchId !== batch.id ||
            intent.requestId !== request.requestId ||
            intent.batchId !== batch.id
          )
            continue;
          const pending = batchSchema.parse({
            ...batch,
            status: 'preparing',
            preparedRequestId: null,
            preparation: {
              requestId: request.requestId,
              kind: intent.kind,
              returnStatus: 'scheduled',
              requestedAt: intent.createdAt,
              attempt: request.attempt,
            },
          });
          // A failed verification never supplies `checked`, so it cannot authorize
          // keep_scheduled restoration. These parsed fields identify failed evidence only.
          await this.failure(tree, pending, request, error, checked);
        }
      }
      if (readyOnly && !recheckedReady) return;
      const deadline = readyOnly ? Infinity : await this.prepareScheduledStages(tree, head);
      this.refreshIndex(tree);
      if (stableStringify(tree) === stableStringify(original)) return;
      const commit = this.pub.git.commit(head, tree, 'Prepare scheduled changes', appCredits);
      if (this.pub.options.now() >= deadline) continue;
      try {
        this.pub.git.cas(ref, head, commit);
        return;
      } catch (error) {
        const observed = this.pub.head(this.pub.options.dataBranch);
        if (observed === commit || this.pub.git.ancestor(commit, observed)) return;
        if (!(error instanceof RefRace)) throw error;
      }
    }
    throw new Error('Schedule preparation CAS exhausted; requests remain durable');
  }

  /** Prepare against a private tree. Only the outer CAS can replace an accepted schedule. */
  async prepareScheduledStages(tree: Tree, head: string): Promise<number> {
    let deadline = Infinity;
    for (const batch of this.batches(tree)) {
      const path = scheduleIntentPaths.stagedSave(batch.id);
      if (!tree[path]) continue;
      const parsed = scheduledStagingSchema.safeParse(this.pub.read(tree, path));
      if (!parsed.success) continue;
      const stage = parsed.data;
      const due = batch.notBefore ? Date.parse(batch.notBefore) : -Infinity;
      const now = this.pub.options.now();
      const consumed =
        !!batch.claim ||
        batch.status === 'published' ||
        (batch.status === 'scheduled' && now >= due);
      const changed = batch.status !== 'scheduled' || batch.revision !== stage.revision;
      if (!stage.ready && !consumed && !changed && now - Date.parse(stage.updatedAt) < 86_400_000)
        continue;
      if (stage.ready) {
        const requestPath = scheduleIntentPaths.request(stage.id);
        const record = scheduleRequestSchema.safeParse(this.pub.read(tree, requestPath));
        if (
          record.success &&
          record.data.batchId === batch.id &&
          record.data.requestId === stage.id &&
          record.data.requesterId === stage.ownerId &&
          record.data.status === 'pending'
        ) {
          const request = record.data;
          try {
            if (consumed) reject('Batch published before these edits landed');
            if (changed) reject('The accepted schedule changed before these edits landed');
            const checked = verifiedRequest(this.pub, tree, requestPath);
            const { intent } = checked;
            if (
              intent.kind !== 'save' ||
              intent.scheduledParts !== stage.parts ||
              intent.expectedRevision !== stage.revision ||
              intent.requester.id !== stage.ownerId
            )
              reject('Staged save identity changed');
            const publicationPath = paths(batch.opId!).request;
            if (!tree[publicationPath]) reject('The accepted publication could not be read');
            const next = {
              ...tree,
              [scheduleIntentPaths.publication(batch.id)]: tree[publicationPath]!,
            };
            delete next[publicationPath];
            const preparing = withEvent(
              this.pub,
              next,
              batch,
              {
                status: 'preparing',
                preparedRequestId: null,
                preparation: {
                  requestId: stage.id,
                  kind: 'save',
                  returnStatus: 'scheduled',
                  requestedAt: intent.createdAt,
                  attempt: request.attempt,
                },
              },
              { at: iso(now), by: intent.requester, action: 'request' },
            );
            next[schedulePaths.batch(batch.id)] = this.pub.writeBlob(json(preparing));
            await this.prepare(next, head, preparing, request, checked);
            if (this.pub.options.now() >= due) reject('Batch published before these edits landed');
            Object.assign(tree, next);
            deadline = Math.min(deadline, due);
          } catch (error) {
            const reason =
              (error instanceof Error ? error.message : String(error)).slice(0, 2000) ||
              'The staged edits could not be applied';
            tree[requestPath] = this.pub.writeBlob(
              json({
                ...request,
                status: 'failed',
                retryable: false,
                reasons: [{ reason }],
                updatedAt: iso(this.pub.options.now()),
              }),
            );
          }
        }
      }
      delete tree[path];
      const prefix = scheduleIntentPaths.stagedPartsPrefix(batch.id, stage.id);
      for (const part of Object.keys(tree)) if (part.startsWith(prefix)) delete tree[part];
    }
    return deadline;
  }
}
