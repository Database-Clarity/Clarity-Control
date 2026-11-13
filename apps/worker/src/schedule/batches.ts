import { z } from 'zod';
import {
  hashSchema,
  merge3,
  sandboxPointersPath,
  stableStringify,
  tooltipSchema,
  type Aliases,
  type Tooltip,
} from '@clarity/core';
import {
  batchIdSchema,
  batchMemberSchema,
  batchSchema,
  batchStatusSchema,
  changedFields,
  compose,
  initialRevisions,
  isContentChange,
  isOpenStatus,
  isTranslationField,
  nextRevisions,
  withField,
  withoutTranslations,
  schedulePaths,
  type Batch,
  type BatchMember,
} from '@clarity/core/schedule';
import { loadAliases } from '../catalog.js';
import { pinLowersElementTags, refuseUnlowerableTags } from '../elementTags.js';
import { blobContent, RefRace, type GitHub, type TreeNode } from '../github.js';
import { body, HttpError, json } from '../http.js';
import { checkEdit, type Access } from '../permissions.js';
import { withSandboxPointers } from '../sandboxPointers.js';
import type { Identity } from '../types.js';
import {
  appendEvent,
  pushedHashes,
  refuseAliases,
  unpublishedMessage,
  archivedCounter,
  by,
  checkedBatch,
  child,
  indexEntry,
  memberByteCap,
  memberCap,
  memberHashes,
  newUlid,
  readRoles,
  readState,
  saveChangeCap,
  refuseClaimed,
  refuseOpenCap,
  refuseRevision,
  requireBatch,
  scheduleRoles,
  switches,
  withIndexEntry,
  type ScheduleState,
} from './store.js';

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const messageSchema = z.string().trim().min(1).max(500);
const changeSchema = z
  .object({ hash: hashSchema, base: tooltipSchema.nullable(), next: tooltipSchema })
  .strict()
  .refine(({ hash, base, next }) => next.hash === hash && (!base || base.hash === hash), {
    message: 'Change hash, base hash and next hash must agree',
  });
const uniqueHashes = (list: readonly { hash: number }[]) =>
  new Set(list.map(({ hash }) => hash)).size === list.length;
const saveSchema = z
  .object({
    revision: revisionSchema,
    changes: z
      .array(changeSchema)
      .min(1)
      .max(saveChangeCap)
      .refine(uniqueHashes, 'Duplicate tooltip hash'),
    message: messageSchema,
  })
  .strict();
const rebaseSchema = z
  .object({
    revision: revisionSchema,
    hash: hashSchema,
    base: tooltipSchema.nullable(),
    next: tooltipSchema,
  })
  .strict()
  .refine(({ hash, base, next }) => next.hash === hash && (!base || base.hash === hash), {
    message: 'Change hash, base hash and next hash must agree',
  });
const removeSchema = z
  .object({
    revision: revisionSchema,
    hashes: z
      .array(hashSchema)
      .min(1)
      .max(memberCap)
      .refine((list) => new Set(list).size === list.length, 'Duplicate tooltip hash'),
  })
  .strict();
// Names land in commit subjects and the UI: no control, format, or bidi characters.
const createSchema = z
  .object({
    name: batchSchema.shape.name.refine(
      (name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name),
      'Name has control or formatting characters',
    ),
  })
  .strict();
/** Request bodies of batch writes (spec "Free-plan budget": ≤300 KiB, as /publish). */
const maxBody = 300 * 1024;

const batchDir = (batchId: string) => `schedule/batches/${batchId}`;
const tooltipPath = (hash: number) => `tooltips/${hash}.json`;
// Both sides are schema-parsed already: equal canonical text = equal contentHash.
const sameTooltip = (a: Tooltip | null, b: Tooltip | null) =>
  a === null || b === null ? a === b : stableStringify(a) === stableStringify(b);
/** Q2 reads only what it decides on from another batch's batch.json (CPU, full histories). */
const holderSchema = z.looseObject({
  id: batchIdSchema,
  name: batchSchema.shape.name,
  status: batchStatusSchema,
});
const encoder = new TextEncoder();

/**
 * `from` with each of `fields` taken from `to`. Stored proposals only ever move by a field the
 * shared changed-field set reports, so a stamp-only difference (R17: a no-op for approvedDigest
 * and contentRevision) never reaches storage and can never change what publishes (I5).
 */
function overlay(from: Tooltip | null, to: Tooltip, fields: readonly string[]): Tooltip {
  if (from === null) return to;
  let value = from;
  for (const field of fields) value = withField(value, to, field);
  return tooltipSchema.parse(value);
}

function parseMember(value: unknown, batchId: string, hash: number): BatchMember {
  const member = batchMemberSchema.parse(value);
  if (member.hash !== hash)
    throw new HttpError(502, `Stored member ${hash} of ${batchId} mismatch`);
  return member;
}

function refuseMemberSize(member: BatchMember): void {
  if (encoder.encode(blobContent(member)).byteLength > memberByteCap)
    throw new HttpError(
      413,
      `Tooltip ${member.hash} is too large to stage in a batch (${memberByteCap / 1024} KiB per tooltip)`,
    );
}

/** Whether the active exporter lowers element-tagged text (as /save decides, elementTags.ts). */
function lowersTags(state: ScheduleState): boolean {
  return !switches.publisher() || pinLowersElementTags(state.pin);
}

function memberFile(member: BatchMember, batchId: string): [string, BatchMember] {
  return [schedulePaths.member(batchId, member.hash), member];
}

/** Writes one batch update (members, deletions, batch.json, index, event archive) by CAS. */
async function commitBatch(
  github: GitHub,
  state: ScheduleState,
  user: Identity,
  {
    batch,
    action,
    hashes,
    members,
    deletions = [],
    membership,
    contentChanged,
    events,
    message,
  }: {
    batch: Batch;
    action: Batch['events'][number]['action'];
    hashes: number[];
    members: BatchMember[];
    deletions?: string[];
    membership: number[];
    contentChanged: boolean;
    events: readonly TreeNode[] | null;
    message: string;
  },
) {
  const now = new Date().toISOString();
  const revisions = nextRevisions(batch, contentChanged);
  const appended = await appendEvent(
    batch,
    { at: now, by: by(user), action, ...revisions, hashes: [...hashes].sort((a, b) => a - b) },
    archivedCounter(github, state.head, batch.id, events),
  );
  const next = checkedBatch({ ...batch, ...revisions, events: appended.events });
  const index = withIndexEntry(state.index, indexEntry(next, membership, now));
  const commit = await github.commit(
    state.head,
    {
      ...Object.fromEntries(members.map((member) => memberFile(member, batch.id))),
      [schedulePaths.batch(batch.id)]: next,
      [schedulePaths.index]: index,
      ...(appended.archive ? { [appended.archive.path]: appended.archive.value } : {}),
    },
    `${message}\n\nClarity-Batch: ${batch.id}`,
    user,
    { baseTree: state.tree, deletions },
  );
  return { commit, batch: next };
}

/** GET /batches: the index at one head; member bodies are fetched from raw at that head. */
export async function listBatches(github: GitHub, user: Identity): Promise<Response> {
  const state = await readState(github, user, readRoles);
  return json({ head: state.head, index: state.index });
}

/** POST /batches {name} */
export async function createBatch(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const { name } = await body(request, createSchema, 4096);
  const id = newUlid();
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, scheduleRoles, { batchId: id });
    if (state.batch) throw new HttpError(409, 'Batch id collision; retry');
    refuseOpenCap(state.index);
    const now = new Date().toISOString();
    const batch = batchSchema.parse({
      id,
      name,
      createdBy: by(user),
      createdAt: now,
      ...initialRevisions,
      status: 'draft',
      notBefore: null,
      zone: null,
      opId: null,
      scheduledContentRevision: null,
      claim: null,
      result: null,
      events: [{ at: now, by: by(user), action: 'create', ...initialRevisions }],
    } satisfies Batch);
    const index = withIndexEntry(state.index, indexEntry(batch, [], now));
    try {
      const commit = await github.commit(
        state.head,
        { [schedulePaths.batch(id)]: batch, [schedulePaths.index]: index },
        `Create batch "${name}"\n\nClarity-Batch: ${id}`,
        user,
        { baseTree: state.tree },
      );
      return json({ commit, batch }, 201);
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}

/**
 * Q2: refuses hashes that a different OPEN batch already holds, from a names-only listing of
 * schedule/batches/<id>/tooltips at the CAS head (never index.json). Terminal batches keep their
 * member files as history, so a listed batch's status decides (one read at the same head).
 */
async function refuseOtherOpenBatches(
  github: GitHub,
  state: ScheduleState,
  listing: readonly TreeNode[] | null,
  batchId: string,
  hashes: readonly number[],
): Promise<void> {
  if (!hashes.length) return;
  const wanted = new Set(hashes);
  const holders = new Map<string, number[]>();
  for (const dir of listing ?? []) {
    if (dir.name === batchId || !batchIdSchema.safeParse(dir.name).success) continue;
    const held = memberHashes(child(dir.entries, 'tooltips')).filter((hash) => wanted.has(hash));
    if (held.length) holders.set(dir.name, held);
  }
  if (!holders.size) return;
  const ids = [...holders.keys()];
  const files = await github.files(
    ids.map((id) => schedulePaths.batch(id)),
    state.head,
  );
  for (const [index, file] of files.entries()) {
    if (!file) continue; // a directory without batch.json holds no batch
    const other = holderSchema.parse(file.value);
    if (other.id !== ids[index]) throw new HttpError(502, 'Stored batch id mismatch');
    if (isOpenStatus(other.status))
      throw new HttpError(
        409,
        `Tooltip ${holders.get(other.id)![0]} is already in the open batch "${other.name}"; one open batch per tooltip`,
        { hashes: holders.get(other.id), batchId: other.id },
      );
  }
}

interface Conflict {
  hash: number;
  base: Tooltip | null;
  head: Tooltip | null;
  next: Tooltip;
  fields: string[];
}

/**
 * POST /batches/:id/save {revision, changes, message}: /save semantics against the members'
 * stored proposals (spec "Worker API", "Permissions").
 */
export async function saveBatch(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
): Promise<Response> {
  const input = await body(request, saveSchema, maxBody);
  let aliases: Aliases | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, [...scheduleRoles, 'translator'], {
      batchId,
      extra: [sandboxPointersPath],
      trees: [{ path: batchDir(batchId), depth: 2 }],
    });
    const batch = requireBatch(state, batchId);
    refuseClaimed(batch);
    refuseRevision(batch, input.revision);
    const access = state.access;
    const ownDir = state.trees[0];
    const own = new Set(memberHashes(child(ownDir, 'tooltips')));
    const adds = input.changes.filter(({ hash }) => !own.has(hash)).map(({ hash }) => hash);
    if (adds.length) {
      if (access.role === 'translator')
        throw new HttpError(403, 'Translators may change only tooltips already in the batch');
      if (batch.status !== 'draft') throw new HttpError(409, 'Unschedule to edit');
      if (own.size + adds.length > memberCap)
        throw new HttpError(409, `A batch holds at most ${memberCap} tooltips`);
    }
    // Every change must name a canonical tooltip, as /save checks (a member the generator has
    // since aliased is refused too: publishing it would export its target instead).
    aliases ??= await loadAliases(github.env, github);
    refuseAliases(
      input.changes.map(({ hash }) => hash),
      await withSandboxPointers(github, aliases, state.extra[0]),
    );
    if (adds.length) {
      // Q2 needs every batch's members: a names-only listing of them all, at the SAME head (a
      // moved head retries the attempt). Edit-only saves never pay for it.
      const listing = await github.publishSnapshot(
        [],
        [],
        [{ path: 'schedule/batches', depth: 3 }],
      );
      if (listing.head !== state.head) continue;
      await refuseOtherOpenBatches(github, state, listing.trees[0] ?? null, batchId, adds);
    }
    // A scheduled batch also reads what composition reads (C1-C4), so a translation save can
    // never make a field `unpublished` behind the signed request (root ruling after P1).
    const scheduled = batch.status !== 'draft';
    const files = await github.files(
      [
        ...input.changes.map(({ hash }) =>
          own.has(hash) ? schedulePaths.member(batchId, hash) : tooltipPath(hash),
        ),
        ...(scheduled
          ? [...input.changes.map(({ hash }) => `live/tooltips/${hash}.json`), 'live/pushed.json']
          : []),
      ],
      state.head,
    );
    const pushed = scheduled ? pushedHashes(files.at(-1)) : undefined;
    const blocked: { hash: number; fields?: string[]; reason?: string }[] = [];
    const lowers = lowersTags(state);
    const now = new Date().toISOString();
    const conflicts: Conflict[] = [];
    const before: BatchMember[] = [];
    const written: BatchMember[] = [];
    for (const [index, change] of input.changes.entries()) {
      const file = files[index];
      if (own.has(change.hash)) {
        if (!file) throw new HttpError(502, `Batch member ${change.hash} is unreadable`);
        const stored = parseMember(file.value, batchId, change.hash);
        let merged = change.next;
        if (change.base === null) {
          conflicts.push({ ...change, head: stored.proposed, fields: ['$exists'] });
          continue;
        }
        // Before the merge against what the client edited, after it against the stored proposal
        // (save.ts:107/:127); the second check is the authoritative one.
        checkEdit(access, change.base, change.next);
        if (!sameTooltip(change.base, stored.proposed)) {
          const result = merge3(change.base, stored.proposed, change.next);
          if (!result.ok) {
            conflicts.push({
              ...change,
              head: stored.proposed,
              fields: result.conflicts.map(({ field }) => field),
            });
            continue;
          }
          merged = result.merged;
        }
        checkEdit(access, stored.proposed, merged);
        const changed = changedFields(stored.proposed, merged);
        if (!changed.length) continue; // stamp-only or identical: a no-op (R17)
        if (batch.status !== 'draft' && changed.some((field) => !isTranslationField(field)))
          throw new HttpError(409, 'Unschedule to edit', { hash: change.hash, fields: changed });
        const proposed = overlay(stored.proposed, merged, changed);
        refuseUnlowerableTags(proposed, lowers, 'saved');
        const member = batchMemberSchema.parse({
          ...stored,
          proposed,
          updatedAt: now,
          updatedBy: user.login,
        });
        refuseMemberSize(member);
        if (pushed) {
          const snapshotFile = files[input.changes.length + index];
          const composed = compose({
            hash: change.hash,
            base: member.base,
            proposed: member.proposed,
            snapshot: snapshotFile ? tooltipSchema.parse(snapshotFile.value) : null,
            pushed: pushed.has(change.hash),
          });
          if (composed.status === 'stale')
            blocked.push({ hash: change.hash, reason: composed.reason });
          else if (composed.status === 'overlay' && composed.unpublished.length)
            blocked.push({ hash: change.hash, fields: composed.unpublished });
        }
        before.push(stored);
        written.push(member);
      } else {
        const current = file ? tooltipSchema.parse(file.value) : null;
        if (current && current.hash !== change.hash)
          throw new HttpError(502, 'Stored tooltip hash mismatch');
        // Adding sets base = current at this head; the client must have started from it.
        if (!sameTooltip(change.base, current)) {
          conflicts.push({
            ...change,
            head: current,
            fields: change.base === null || current === null ? ['$exists'] : ['$base'],
          });
          continue;
        }
        checkEdit(access, current, change.next);
        const changed = changedFields(current, change.next);
        if (!changed.length) continue; // nothing to stage
        const proposed = overlay(current, change.next, changed);
        refuseUnlowerableTags(proposed, lowers, 'saved');
        const member = batchMemberSchema.parse({
          hash: change.hash,
          base: current,
          baseCommit: state.head,
          proposed,
          updatedAt: now,
          updatedBy: user.login,
        });
        refuseMemberSize(member);
        written.push(member);
      }
    }
    if (conflicts.length) return json({ conflicts }, 409);
    if (blocked.length) throw new HttpError(409, unpublishedMessage, { members: blocked });
    if (!written.length) return json({ commit: null, batch, members: [] });
    // approvalInput depends only on membership, bases, and the proposals without translations,
    // so a save that adds nothing and keeps every non-translation part is no content change
    // (exact; saves never move a base). Otherwise core decides.
    const contentChanged =
      written.length !== before.length ||
      before.some(
        (stored, index) =>
          stableStringify(withoutTranslations(stored.proposed)) !==
          stableStringify(withoutTranslations(written[index]!.proposed)),
      )
        ? isContentChange(before, written)
        : false;
    // Translation-only edits keep a scheduled batch's signed content (I5).
    if (batch.status !== 'draft' && contentChanged) throw new HttpError(409, 'Unschedule to edit');
    const membership = [...new Set([...own, ...written.map(({ hash }) => hash)])];
    try {
      const result = await commitBatch(github, state, user, {
        batch,
        action: 'save',
        hashes: written.map(({ hash }) => hash),
        members: written,
        membership,
        contentChanged,
        events: child(ownDir, 'events'),
        message: input.message,
      });
      return json({ ...result, members: written, savedAt: Date.now() });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry your save');
}

/** Reads a draft batch and its own listing for a maintainer/editor content write. */
async function draftState(github: GitHub, user: Identity, batchId: string, revision: number) {
  const state = await readState(github, user, scheduleRoles, {
    batchId,
    trees: [{ path: batchDir(batchId), depth: 2 }],
  });
  const batch = requireBatch(state, batchId);
  refuseClaimed(batch);
  refuseRevision(batch, revision);
  if (batch.status !== 'draft') throw new HttpError(409, 'Unschedule to edit');
  const own = memberHashes(child(state.trees[0], 'tooltips'));
  return { state, batch, own, events: child(state.trees[0], 'events') };
}

/**
 * POST /batches/:id/rebase {revision, hash, base, next}: maintainer/editor only (a translator can
 * never move a base). The new base is current at this head; `next` is the rebased proposal.
 */
export async function rebaseBatch(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
): Promise<Response> {
  const input = await body(request, rebaseSchema, maxBody);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, batch, own, events } = await draftState(github, user, batchId, input.revision);
    if (!own.includes(input.hash))
      throw new HttpError(404, `Tooltip ${input.hash} is not in this batch`);
    const [memberRaw, currentRaw] = await github.files(
      [schedulePaths.member(batchId, input.hash), tooltipPath(input.hash)],
      state.head,
    );
    if (!memberRaw) throw new HttpError(502, `Batch member ${input.hash} is unreadable`);
    const stored = parseMember(memberRaw.value, batchId, input.hash);
    const current = currentRaw ? tooltipSchema.parse(currentRaw.value) : null;
    if (current && current.hash !== input.hash)
      throw new HttpError(502, 'Stored tooltip hash mismatch');
    if (!sameTooltip(input.base, current))
      return json({ error: 'Current changed; rebase again', current }, 409);
    checkEdit(state.access, stored.proposed, input.next);
    checkEdit(state.access, current, input.next);
    const changed = changedFields(current, input.next);
    if (!changed.length)
      throw new HttpError(422, 'Nothing left to publish; remove the tooltip from the batch');
    const proposed = overlay(current, input.next, changed);
    refuseUnlowerableTags(proposed, lowersTags(state), 'saved');
    const member = batchMemberSchema.parse({
      hash: input.hash,
      base: current,
      baseCommit: state.head,
      proposed,
      updatedAt: new Date().toISOString(),
      updatedBy: user.login,
    });
    refuseMemberSize(member);
    try {
      const result = await commitBatch(github, state, user, {
        batch,
        action: 'rebase',
        hashes: [input.hash],
        members: [member],
        membership: own,
        contentChanged: isContentChange([stored], [member]),
        events,
        message: `Rebase ${input.hash} in batch "${batch.name}"`,
      });
      return json({ ...result, members: [member] });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}

/** POST /batches/:id/remove {revision, hashes}: maintainer/editor; draft only. */
export async function removeFromBatch(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
): Promise<Response> {
  const input = await body(request, removeSchema, 64 * 1024);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, batch, own, events } = await draftState(github, user, batchId, input.revision);
    const missing = input.hashes.filter((hash) => !own.includes(hash));
    if (missing.length)
      throw new HttpError(404, `Tooltip ${missing[0]} is not in this batch`, { hashes: missing });
    const files = await github.files(
      input.hashes.map((hash) => schedulePaths.member(batchId, hash)),
      state.head,
    );
    const removed = files.map((file, index) => {
      if (!file) throw new HttpError(502, `Batch member ${input.hashes[index]} is unreadable`);
      return parseMember(file.value, batchId, input.hashes[index]!);
    });
    // Dropping a proposal must be an edit this role could make on the stored member.
    for (const member of removed)
      if (member.base) checkEdit(state.access, member.proposed, member.base);
    const gone = new Set(input.hashes);
    try {
      const result = await commitBatch(github, state, user, {
        batch,
        action: 'remove',
        hashes: input.hashes,
        members: [],
        deletions: input.hashes.map((hash) => schedulePaths.member(batchId, hash)),
        membership: own.filter((hash) => !gone.has(hash)),
        contentChanged: true,
        events,
        message: `Remove ${input.hashes.length} tooltip(s) from batch "${batch.name}"`,
      });
      return json(result);
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}

export type { Access };
