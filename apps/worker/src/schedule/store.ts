import scheduledConfig from '../../../../config/scheduled.json';
import publisherConfig from '../../../../config/publisher.json';
import { permissionsSchema, resolveAlias, type Aliases, type Permissions } from '@clarity/core';
import {
  batchEventSchema,
  batchSchema,
  batchStatusSchema,
  dueSchema,
  isOpenStatus,
  scheduleIndexSchema,
  scheduleLimits,
  schedulePaths,
  type Batch,
  type Due,
  type ScheduleIndex,
} from '@clarity/core/schedule';
import { z } from 'zod';
import { publisherPinPath } from '../elementTags.js';
import { HttpError } from '../http.js';
import { requireAccess, type Access } from '../permissions.js';
import type { GitHub, RepoFile, TreeNode } from '../github.js';
import type { Identity } from '../types.js';

/**
 * Build switches (spec I6). config/scheduled.json OFF: every /batches route answers 503 before
 * authentication and the per-minute cron makes no I/O. Getters, so tests can turn them on.
 */
export const switches = {
  scheduled: (): boolean => scheduledConfig.enabled,
  publisher: (): boolean => publisherConfig.enabled,
};

/** PIN capability of a publisher build that drains, claims, and records `batch` requests (I6). */
export const scheduledBatchesCapability = 'scheduledBatches';
export function pinSchedulesBatches(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(scheduledBatchesCapability);
}

/** Every hash must be canonical, with /save's message (an aliased member would export its target). */
export function refuseAliases(hashes: readonly number[], aliases: Aliases): void {
  for (const hash of hashes) {
    const canonical = resolveAlias(hash, aliases);
    if (canonical !== hash)
      throw new HttpError(422, `Tooltip ${hash} is an alias; edit canonical tooltip ${canonical}`);
  }
}

/** Root ruling after P1: batch fields carrying saved-but-unpublished work are refused (I3). */
export const unpublishedMessage =
  'This field has saved changes that are not published yet; publish them first';

/**
 * The hashes live/pushed.json names. Composition only asks whether a hash was ever pushed, so
 * the ~2,500-entry marker is checked for shape, not re-validated digest by digest (CPU).
 */
export function pushedHashes(file: RepoFile | null | undefined): Set<number> {
  const value = file?.value ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(502, 'Invalid live/pushed.json');
  return new Set(Object.keys(value).map(Number));
}

/** Roles that may write batches (Q3: trials get no batch access; translators per Permissions). */
export const scheduleRoles: Access['role'][] = ['maintainer', 'editor'];
export const readRoles: Access['role'][] = ['maintainer', 'editor', 'translator'];

/**
 * Members per batch the Worker admits (root 2026-11-13, CPU gate option A; core allows 100).
 * Scheduling validates every member in ONE request inside the Workers Free 10 ms CPU limit, so
 * this is a workflow limit, kept as one constant so it can move with the measured gate.
 */
export const memberCap = 15;
/** Changes per POST /batches/:id/save (same gate); the web chunks larger saves (P3a). */
export const saveChangeCap = 15;

/**
 * Bytes one stored member file may take (base + proposal, pretty JSON). The largest real tooltip
 * is 2,112 bytes (editor-data 6ac370e3), so its member is about 4.6 KB; the cap bounds what
 * repeated translation saves can accumulate and the CPU of reading every member (CPU gate,
 * scripts/publisher/cpu/schedule.mjs). Lower it, never a check, if the gate fails.
 */
export const memberByteCap = 8 * 1024;

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A ULID (batch id, opId): 48-bit millisecond time + 80 random bits, Crockford base32. */
export function newUlid(now = Date.now()): string {
  let time = '';
  let rest = now;
  for (let index = 0; index < 10; index++) {
    time = alphabet[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  let tail = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) tail += alphabet[byte % 32];
  return time + tail;
}

export const by = (user: Identity) => ({ id: user.id, login: user.login });

// --- Event overflow (root ruling 2026-11-13, shared with the publisher, P4) -------------------
/**
 * batch.json keeps the newest `scheduleLimits.inlineEvents` (200) events. A write that overflows
 * moves the oldest ones, in the SAME commit, to `schedule/batches/<id>/events/<seq>.json` with
 * body {events: [...]} oldest first, where seq = the zero-padded 8-digit count of events archived
 * before this file (the first file is 00000000.json).
 */
export const eventArchivePath = (batchId: string, seq: number) =>
  `schedule/batches/${batchId}/events/${String(seq).padStart(8, '0')}.json`;
const eventArchiveName = /^(\d{8})\.json$/;
const eventArchiveSchema = z.object({ events: z.array(z.unknown()).min(1) }).strict();

/** The latest archive file named in a names-only listing of the events directory. */
export function latestEventArchive(names: readonly TreeNode[] | null | undefined) {
  let latest: number | undefined;
  for (const { name } of names ?? []) {
    const match = eventArchiveName.exec(name);
    if (match && (latest === undefined || Number(match[1]) > latest)) latest = Number(match[1]);
  }
  return latest;
}

/**
 * Appends `event` to `batch.events` per the overflow rule. `archivedBefore` resolves the count
 * of already archived events; it is called only when the write overflows.
 */
export async function appendEvent(
  batch: Batch,
  event: Batch['events'][number],
  archivedBefore: () => Promise<number>,
): Promise<{ events: Batch['events']; archive?: { path: string; value: { events: unknown[] } } }> {
  const events = [...batch.events, batchEventSchema.parse(event)];
  const overflow = events.length - scheduleLimits.inlineEvents;
  if (overflow <= 0) return { events };
  const seq = await archivedBefore();
  return {
    events: events.slice(overflow),
    archive: {
      path: eventArchivePath(batch.id, seq),
      value: { events: events.slice(0, overflow) },
    },
  };
}

/** archivedBefore for appendEvent: the latest archive's seq plus its event count (one read). */
export function archivedCounter(
  github: GitHub,
  head: string,
  batchId: string,
  listing: readonly TreeNode[] | null | undefined,
) {
  return async () => {
    const latest = latestEventArchive(listing);
    if (latest === undefined) return 0;
    const [file] = await github.files([eventArchivePath(batchId, latest)], head);
    if (!file) throw new HttpError(502, 'Batch event archive is unreadable');
    return latest + eventArchiveSchema.parse(file.value).events.length;
  };
}

// --- Stored batch.json and index.json -------------------------------------------------------
// CPU (spec "Free-plan budget"): a full history is 200 events of up to 100 hashes, and a full
// index 150 entries of up to 100 hashes. The Worker never interprets inherited events or other
// batches' index entries, so they are checked for shape and passed through unchanged; every
// field the Worker reads, and everything it adds, is validated with the core schemas.

/** batch.json: the full core schema (its invariants included) on all but the inherited events. */
export function parseBatch(value: unknown): Batch {
  const { events, ...rest } = (value ?? {}) as Record<string, unknown>;
  const batch = batchSchema.parse({ ...rest, events: [] });
  if (
    !Array.isArray(events) ||
    events.length > scheduleLimits.inlineEvents ||
    events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))
  )
    throw new HttpError(502, 'Invalid batch event history');
  return { ...batch, events: events as Batch['events'] };
}

/** The batch.json a write stores: the core schema on every field (appendEvent checks events). */
export function checkedBatch(batch: Batch): Batch {
  const { events, ...rest } = batch;
  batchSchema.parse({ ...rest, events: [] });
  if (events.length > scheduleLimits.inlineEvents)
    throw new HttpError(502, 'Batch history over its inline cap');
  return batch;
}

type IndexEntry = ScheduleIndex['batches'][number];
const indexEntrySchema = scheduleIndexSchema.shape.batches.element;
const storedIndexSchema = z
  .object({
    batches: z
      .array(z.looseObject({ id: z.string(), status: batchStatusSchema, updatedAt: z.string() }))
      .max(scheduleLimits.openBatches + scheduleLimits.indexTerminal),
  })
  .strict();

/** index.json: derived and advisory; entries are passed through, ids and statuses checked. */
export function parseIndex(value: unknown): ScheduleIndex {
  return storedIndexSchema.parse(value) as unknown as ScheduleIndex;
}

export function indexEntry(batch: Batch, hashes: readonly number[], updatedAt: string): IndexEntry {
  return indexEntrySchema.parse({
    id: batch.id,
    name: batch.name,
    status: batch.status,
    notBefore: batch.notBefore,
    opId: batch.opId,
    revision: batch.revision,
    hashes: [...hashes].sort((a, b) => a - b),
    updatedAt,
  });
}

/** index.json with `entry` replacing its batch; only the latest 100 terminal entries are kept. */
export function withIndexEntry(index: ScheduleIndex, entry: IndexEntry): ScheduleIndex {
  const batches = [...index.batches.filter(({ id }) => id !== entry.id), entry];
  const terminal = batches
    .filter(({ status }) => !isOpenStatus(status))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const dropped = new Set(terminal.slice(scheduleLimits.indexTerminal).map(({ id }) => id));
  const kept = batches.filter(({ id }) => !dropped.has(id));
  if (new Set(kept.map(({ id }) => id)).size !== kept.length)
    throw new HttpError(502, 'Duplicate batch in index.json');
  if (kept.filter(({ status }) => isOpenStatus(status)).length > scheduleLimits.openBatches)
    throw new HttpError(409, `At most ${scheduleLimits.openBatches} open batches`);
  return { batches: kept };
}

/** Open batches other than `except`, by the index (a storage bound, not a publication guard). */
export function openCount(index: ScheduleIndex, except?: string): number {
  return index.batches.filter(({ id, status }) => id !== except && isOpenStatus(status)).length;
}

export function refuseOpenCap(index: ScheduleIndex, except?: string): void {
  if (openCount(index, except) >= scheduleLimits.openBatches)
    throw new HttpError(
      409,
      `At most ${scheduleLimits.openBatches} open batches; publish or cancel one first`,
    );
}

export function withDueEntry(due: Due, entry: Due['entries'][number]): Due {
  return dueSchema.parse({
    entries: [...due.entries.filter(({ batchId }) => batchId !== entry.batchId), entry],
  });
}
export function withoutDueEntry(due: Due, batchId: string): Due {
  return { entries: due.entries.filter((entry) => entry.batchId !== batchId) };
}

// --- One head per attempt ------------------------------------------------------------------
export interface ScheduleState {
  head: string;
  tree: string;
  config: Permissions;
  access: Access;
  pin: unknown;
  due: Due;
  index: ScheduleIndex;
  batch: Batch | null;
  /** Files of `extra`, in order. */
  extra: (RepoFile | null)[];
  /** Listings of `trees`, in order. */
  trees: (TreeNode[] | null)[];
}

const fixed = ['config/permissions.json', publisherPinPath, schedulePaths.due, schedulePaths.index];

/**
 * permissions, PIN, due.json, index.json, the batch, `extra` files, and `trees` listings, all at
 * ONE head in ONE GraphQL subrequest. Roles are checked before anything else is parsed.
 */
export async function readState(
  github: GitHub,
  user: Identity,
  roles: Access['role'][],
  {
    batchId,
    extra = [],
    trees = [],
  }: {
    batchId?: string;
    extra?: readonly string[];
    trees?: readonly { path: string; depth: number }[];
  } = {},
): Promise<ScheduleState> {
  const paths = [...fixed, ...(batchId ? [schedulePaths.batch(batchId)] : []), ...extra];
  const snapshot = await github.publishSnapshot(paths, [], trees);
  const config = permissionsSchema.parse(snapshot.files[0]?.value);
  const access = requireAccess(config, user, roles);
  const batchFile = batchId ? snapshot.files[fixed.length] : null;
  return {
    head: snapshot.head,
    tree: snapshot.tree,
    config,
    access,
    pin: snapshot.files[1]?.value ?? null,
    due: snapshot.files[2] ? dueSchema.parse(snapshot.files[2].value) : { entries: [] },
    index: snapshot.files[3] ? parseIndex(snapshot.files[3].value) : { batches: [] },
    batch: batchFile ? parseBatch(batchFile.value) : null,
    extra: snapshot.files.slice(paths.length - extra.length),
    trees: snapshot.trees,
  };
}

/** The batch a write targets, or 404; refuses every write once a claim exists (I2). */
export function requireBatch(state: ScheduleState, batchId: string): Batch {
  const batch = state.batch;
  if (!batch || batch.id !== batchId) throw new HttpError(404, 'Batch not found');
  return batch;
}

export function refuseClaimed(batch: Batch): void {
  if (batch.claim !== null || batch.status === 'publishing')
    throw new HttpError(409, 'Publishing started');
  if (batch.status === 'published') throw new HttpError(409, 'This batch is published');
  if (batch.status === 'cancelled') throw new HttpError(409, 'This batch is cancelled');
}

export function refuseRevision(batch: Batch, revision: number): void {
  if (batch.revision !== revision)
    throw new HttpError(409, 'The batch changed; reload it and retry', {
      revision: batch.revision,
    });
}

/** Member hashes of a batch from a names-only `tooltips` listing (authoritative at the head). */
export function memberHashes(listing: readonly TreeNode[] | null | undefined): number[] {
  const hashes: number[] = [];
  for (const { name } of listing ?? []) {
    const match = /^(0|[1-9]\d*)\.json$/.exec(name);
    if (match) hashes.push(Number(match[1]));
  }
  return hashes.sort((a, b) => a - b);
}

/** A batch directory's child listing by name (`tooltips`, `events`) from a depth-2+ listing. */
export function child(listing: readonly TreeNode[] | null | undefined, name: string) {
  return listing?.find((entry) => entry.name === name)?.entries ?? null;
}
