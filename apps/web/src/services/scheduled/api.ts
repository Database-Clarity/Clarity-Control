/**
 * Scheduled changes: the batch routes (spec "Worker API"), shared by the editor's Current /
 * Upcoming switch (P3b) and the Review Batches subview and save destination (P3a). `listBatches`
 * asks the Worker for the index and the editor-data head it read; member bodies, batch.json, event
 * pages, and activation conflicts are then read from raw.githubusercontent.com at THAT head
 * (commit-pinned, public, zero Worker CPU) and cached per head. Writes go to the Worker, which is
 * the guard; its refusals reach the UI verbatim (BatchRefusal). With the build switch OFF (I6)
 * every call throws before any request, and the callers never load this module (they gate on the
 * inline `import.meta.env` test).
 */
import { tooltipSchema, type Tooltip } from '@clarity/core';
import {
  activationConflictSchema,
  batchEventSchema,
  batchIdSchema,
  batchMemberSchema,
  batchSchema,
  scheduleIndexSchema,
  schedulePaths,
  type ActivationConflict,
  type Batch,
  type BatchMember,
  type ScheduleIndex,
} from '@clarity/core/schedule';
import { z } from 'zod';
import { apiRequest, failure } from '../apiAuth';
import { scheduledEnabled } from './flag';
import { parseMemberTexts, type MemberParse } from './api.parse';

/** editor-data lives in this repository; a head SHA pins every read to one commit. */
const rawSource = 'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database';
const headSchema = z.string().regex(/^[0-9a-f]{40}$/);
const listingSchema = z.object({ head: headSchema, index: scheduleIndexSchema });

export interface BatchListing {
  /** The editor-data commit the Worker read; member bodies are read at this commit. */
  head: string;
  index: ScheduleIndex;
}

function requireEnabled() {
  if (!scheduledEnabled()) throw new Error('Scheduled changes are off');
}

/** GET /batches: any signed-in maintainer, editor, or translator (trials are refused, Q3). */
export async function listBatches(signal?: AbortSignal): Promise<BatchListing> {
  requireEnabled();
  const response = await apiRequest('/batches', { signal, cache: 'no-store' });
  if (!response.ok) return failure(response);
  return listingSchema.parse(await response.json());
}

type Fetcher = (url: string) => Promise<Response>;
const network: Fetcher = (url) => fetch(url, { credentials: 'omit' });
let fetcher: Fetcher = network;
/** Parsed members per `<head>/<batchId>/<hash>`: a commit never changes, so entries never go stale. */
const members = new Map<string, Promise<BatchMember | null>>();
/** Heads kept: the newest few, so a long session does not hold every past commit's members. */
const keptHeads: string[] = [];
const maxHeads = 4;

/** Tests and browser fixtures: replace the raw reader (`undefined` restores the network) and clear the cache. */
export function setRawFetch(next: Fetcher | undefined) {
  fetcher = next ?? network;
  members.clear();
  batchFiles.clear();
  conflictFiles.clear();
  keptHeads.length = 0;
}

function keepHead(head: string) {
  if (keptHeads.includes(head)) return;
  keptHeads.push(head);
  while (keptHeads.length > maxHeads) {
    const dropped = keptHeads.shift()!;
    for (const key of members.keys()) if (key.startsWith(`${dropped}/`)) members.delete(key);
  }
}

let worker: Worker | undefined;
let nextJob = 0;
const pending = new Map<
  number,
  { resolve(value: BatchMember[]): void; reject(error: Error): void }
>();

/** Member bodies are validated in a worker, so up to 25 tooltips never block the editor. */
function parseMembers(jobs: MemberParse[]): Promise<BatchMember[]> {
  if (!jobs.length) return Promise.resolve([]);
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => parseMemberTexts(jobs));
  if (!worker) {
    worker = new Worker(new URL('./api.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (
      event: MessageEvent<{ id: number; members?: BatchMember[]; error?: string }>,
    ) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.members) request.resolve(event.data.members);
      else request.reject(new Error(event.data.error ?? 'Batch member parse failed'));
    };
    worker.onerror = (event) => {
      for (const request of pending.values())
        request.reject(new Error(event.message || 'Batch member worker failed'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  const id = ++nextJob;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, jobs });
  });
}

async function fetchText(head: string, batchId: string, hash: number): Promise<string | null> {
  const response = await fetcher(`${rawSource}/${head}/${schedulePaths.member(batchId, hash)}`);
  // A member removed at this head (or a batch the index named but the commit lacks): no body.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Batch member ${hash}: HTTP ${response.status}`);
  return response.text();
}

/**
 * The members of one batch at `head`, in `hashes` order (null: no file for that hash at the head).
 * Bodies already read at this head come from the cache; the rest are fetched in parallel and
 * parsed in one worker round trip. A failure rejects and is not cached, so a retry fetches again.
 */
export async function readBatchMembers(
  head: string,
  batchId: string,
  hashes: readonly number[],
): Promise<(BatchMember | null)[]> {
  requireEnabled();
  headSchema.parse(head);
  keepHead(head);
  const key = (hash: number) => `${head}/${batchId}/${hash}`;
  const missing = hashes.filter((hash) => !members.has(key(hash)));
  if (missing.length) {
    const batch = (async () => {
      const texts = await Promise.all(missing.map((hash) => fetchText(head, batchId, hash)));
      const jobs: MemberParse[] = [];
      texts.forEach((text, index) => {
        if (text !== null) jobs.push({ hash: missing[index], text });
      });
      const parsed = await parseMembers(jobs);
      return new Map(parsed.map((member) => [member.hash, member]));
    })();
    for (const hash of missing) {
      const entry = batch.then((found) => found.get(hash) ?? null);
      members.set(key(hash), entry);
      // Never cache a failure: the next read tries the network again.
      entry.catch(() => {
        if (members.get(key(hash)) === entry) members.delete(key(hash));
      });
    }
  }
  return Promise.all(hashes.map((hash) => members.get(key(hash))!));
}

// --- Batch detail reads (P3a): batch.json, event overflow pages, and activation conflicts -----

const batchFiles = new Map<string, Promise<Batch | null>>();
const conflictFiles = new Map<string, Promise<ActivationConflict | null>>();

async function rawJson(head: string, path: string): Promise<unknown> {
  const response = await fetcher(`${rawSource}/${head}/${path}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return JSON.parse(await response.text()) as unknown;
}

/** Caches one commit-pinned read; a failure is dropped so a retry fetches again. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>) {
  let entry = cache.get(key);
  if (!entry) {
    const created = read();
    entry = created;
    cache.set(key, created);
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
    created.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
  }
  return entry;
}

/** schedule/batches/<id>/batch.json at `head` (null: no such batch at that commit). */
export function readBatch(head: string, batchId: string): Promise<Batch | null> {
  requireEnabled();
  headSchema.parse(head);
  batchIdSchema.parse(batchId);
  return cached(batchFiles, `${head}/${batchId}`, async () => {
    const value = await rawJson(head, schedulePaths.batch(batchId));
    if (value === undefined) return null;
    const batch = batchSchema.parse(value);
    if (batch.id !== batchId) throw new Error(`batch.json of ${batchId} names ${batch.id}`);
    return batch;
  });
}

const eventPageSchema = z.object({ events: z.array(batchEventSchema).min(1) }).strict();
export type BatchEvent = Batch['events'][number];
/** schedule/batches/<id>/events/<seq>.json (root ruling 2026-11-13: seq = events archived before). */
export const eventPagePath = (batchId: string, seq: number) =>
  `schedule/batches/${batchId}/events/${String(seq).padStart(8, '0')}.json`;

/**
 * The events a batch moved out of batch.json (oldest first), read page by page from 00000000 at
 * `head` until a page is missing. Only asked for when the detail shows its older events.
 */
export async function readArchivedEvents(head: string, batchId: string): Promise<BatchEvent[]> {
  requireEnabled();
  headSchema.parse(head);
  batchIdSchema.parse(batchId);
  const events: BatchEvent[] = [];
  // Bounded: every page holds at least one event.
  for (let page = 0; page < 10_000; page++) {
    const value = await rawJson(head, eventPagePath(batchId, events.length));
    if (value === undefined) return events;
    events.push(...eventPageSchema.parse(value).events);
  }
  throw new Error('Too many archived event pages');
}

/** schedule/activation-conflicts/<hash>.json at `head` for each hash (null: none). */
export function readActivationConflicts(
  head: string,
  hashes: readonly number[],
): Promise<(ActivationConflict | null)[]> {
  requireEnabled();
  headSchema.parse(head);
  return Promise.all(
    hashes.map((hash) =>
      cached(conflictFiles, `${head}/${hash}`, async () => {
        const value = await rawJson(head, schedulePaths.conflict(hash));
        if (value === undefined) return null;
        const conflict = activationConflictSchema.parse(value);
        if (conflict.hash !== hash) throw new Error(`Conflict file ${hash} holds ${conflict.hash}`);
        return conflict;
      }),
    ),
  );
}

// --- Batch writes (P3a). The Worker is the guard; its refusals reach the UI verbatim. ---------

/** Changes per POST /batches/:id/save (Worker caps, root ruling after P1; apps/worker store.ts). */
export const saveChunk = { draft: 15, scheduled: 10 } as const;
/** Tooltips per batch the Worker admits (apps/worker store.ts memberCap); the UI warns before it. */
export const memberCap = 15;

const memberRefusalSchema = z.looseObject({
  hash: z.number(),
  fields: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
const refusalSchema = z.looseObject({
  error: z.string(),
  details: z
    .looseObject({
      members: z.array(memberRefusalSchema).optional(),
      revision: z.number().optional(),
      hash: z.number().optional(),
      hashes: z.array(z.number()).optional(),
      fields: z.array(z.string()).optional(),
    })
    .optional(),
  missing: z.array(z.string()).optional(),
  current: tooltipSchema.nullable().optional(),
});
const conflictsSchema = z.object({
  conflicts: z.array(z.looseObject({ hash: z.number(), fields: z.array(z.string()) })),
});

export interface MemberRefusal {
  hash: number;
  fields?: string[];
  reason?: string;
}

/** A refused batch request: the Worker's own message, plus what it listed per tooltip. */
export class BatchRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly members: MemberRefusal[] = [],
    /** 409 "The batch changed": the batch's revision now. */
    readonly revision?: number,
    /** Resolve and rebase: current at the head the Worker read. */
    readonly current?: Tooltip | null,
    /** Resolve: fields that now need a choice. */
    readonly missing?: string[],
    /** Save: the Worker answered with per-tooltip merge conflicts (nothing was written). */
    readonly conflicts = false,
  ) {
    super(message);
    this.name = 'BatchRefusal';
  }
}

async function refusal(response: Response): Promise<BatchRefusal> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return new BatchRefusal(response.status, text.trim() || `HTTP ${response.status}`);
  }
  const conflicts = conflictsSchema.safeParse(value);
  if (conflicts.success)
    return new BatchRefusal(
      response.status,
      'These tooltips changed in the batch or in current meanwhile',
      conflicts.data.conflicts.map(({ hash, fields }) => ({ hash, fields })),
      undefined,
      undefined,
      undefined,
      true,
    );
  const parsed = refusalSchema.safeParse(value);
  if (!parsed.success) return new BatchRefusal(response.status, text.trim());
  const { error, details, missing, current } = parsed.data;
  const members =
    details?.members?.map(({ hash, fields, reason }) => ({ hash, fields, reason })) ??
    (details?.hash !== undefined
      ? [{ hash: details.hash, fields: details.fields }]
      : (details?.hashes?.map((hash) => ({ hash })) ?? []));
  return new BatchRefusal(response.status, error, members, details?.revision, current, missing);
}

async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  requireEnabled();
  const response = await apiRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await refusal(response);
  return schema.parse(await response.json());
}

const writeSchema = z.looseObject({ commit: headSchema, batch: batchSchema });

/** POST /batches {name}: a new draft batch. */
export function createBatch(name: string) {
  return post('/batches', { name }, writeSchema);
}

export interface BatchChange {
  hash: number;
  base: Tooltip | null;
  next: Tooltip;
}

export interface BatchSaveResult {
  /** The batch after the last committed chunk (null: nothing was committed). */
  batch: Batch | null;
  /** Members the Worker wrote, across every chunk. */
  members: BatchMember[];
  /** One commit per chunk that changed something. */
  commits: string[];
  /** Hashes of the changes in chunks that committed (or were no-ops). */
  accepted: number[];
}

/** A chunked save that stopped part way: earlier chunks are committed; the rest were not sent. */
export class PartialBatchSave extends Error {
  constructor(
    readonly saved: BatchSaveResult,
    readonly reason: Error,
    readonly unsaved: number[],
  ) {
    super(reason.message);
    this.name = 'PartialBatchSave';
  }
}

const saveResponseSchema = z.looseObject({
  commit: headSchema.nullable(),
  batch: batchSchema,
  members: z.array(batchMemberSchema),
});

/**
 * POST /batches/:id/save in chunks of 15 (draft) or 10 (scheduled) changes, each sent with the
 * revision the previous chunk returned (revision CAS), so no chunk can land on a batch someone
 * else changed meanwhile. A refusal of the first chunk throws its BatchRefusal (nothing saved);
 * a later one throws PartialBatchSave naming what was saved and what was not. `proceed` is asked
 * right before each chunk (in the same tick as the request reads the session): false stops the
 * save there, keeping the chunks already committed.
 */
export async function saveToBatch(
  batchId: string,
  revision: number,
  status: Batch['status'],
  changes: readonly BatchChange[],
  message: string,
  proceed: () => boolean = () => true,
): Promise<BatchSaveResult> {
  batchIdSchema.parse(batchId);
  let expected = revision;
  let size: number = status === 'draft' ? saveChunk.draft : saveChunk.scheduled;
  const saved: BatchSaveResult = { batch: null, members: [], commits: [], accepted: [] };
  for (let start = 0; start < changes.length;) {
    const chunk = changes.slice(start, start + size);
    try {
      if (!proceed()) throw new Error(accountChanged);
      const result = await post(
        `/batches/${batchId}/save`,
        { revision: expected, changes: chunk, message },
        saveResponseSchema,
      );
      saved.batch = result.batch;
      saved.members.push(...result.members);
      saved.accepted.push(...chunk.map(({ hash }) => hash));
      if (result.commit) saved.commits.push(result.commit);
      expected = result.batch.revision;
      size = result.batch.status === 'draft' ? saveChunk.draft : saveChunk.scheduled;
      start += chunk.length;
    } catch (error) {
      if (!saved.accepted.length) throw error;
      throw new PartialBatchSave(
        saved,
        error instanceof Error ? error : new Error(String(error)),
        changes.slice(start).map(({ hash }) => hash),
      );
    }
  }
  return saved;
}

/** Why a batch save stopped before a chunk: the signed-in account is not the one that began it. */
export const accountChanged =
  'The signed-in account changed during the save, so nothing more was sent';

/** POST /batches/:id/rebase: the member's base becomes current at the head; `next` its proposal. */
export function rebaseMember(
  batchId: string,
  revision: number,
  hash: number,
  base: Tooltip | null,
  next: Tooltip,
) {
  return post(
    `/batches/${batchId}/rebase`,
    { revision, hash, base, next },
    writeSchema.extend({ members: z.array(batchMemberSchema) }),
  );
}

export function removeFromBatch(batchId: string, revision: number, hashes: number[]) {
  return post(`/batches/${batchId}/remove`, { revision, hashes }, writeSchema);
}

/** Schedule or reschedule; `'now'` is Publish now (the Worker takes the current minute). */
export function scheduleBatch(
  batchId: string,
  revision: number,
  notBefore: string | 'now',
  zone: string,
) {
  return post(
    `/batches/${batchId}/schedule`,
    { revision, notBefore, zone },
    writeSchema.extend({ opId: z.string(), firstPublications: z.array(z.number()).optional() }),
  );
}

export function endBatchSchedule(
  batchId: string,
  revision: number,
  action: 'unschedule' | 'cancel',
) {
  return post(`/batches/${batchId}/${action}`, { revision }, writeSchema);
}

/** POST /batches/:id/resolve: Apply upcoming / Keep current per conflicted field. */
export function resolveActivationConflict(
  batchId: string,
  hash: number,
  expectedCurrent: string | null,
  choices: Record<string, 'upcoming' | 'current'>,
) {
  return post(
    `/batches/${batchId}/resolve`,
    { hash, expectedCurrent, choices },
    writeSchema.extend({ tooltip: tooltipSchema.nullable() }),
  );
}

/** POST /batches/:id/kick: re-trigger an overdue batch. */
export function kickBatch(batchId: string) {
  return post(
    `/batches/${batchId}/kick`,
    {},
    z.looseObject({ batchId: z.string(), status: z.string() }),
  );
}
