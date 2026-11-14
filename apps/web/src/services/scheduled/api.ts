/**
 * Scheduled changes: the read side of the batch routes (spec "Worker API"), shared by the editor's
 * Current / Upcoming switch (P3b) and the later Review UI. `listBatches` asks the Worker for the
 * index and the editor-data head it read; member bodies are then read from raw.githubusercontent.com
 * at THAT head (commit-pinned, public, zero Worker CPU), parsed and validated off the main thread,
 * and cached per head. With the build switch OFF (I6) every call throws before any request, and the
 * callers never load this module (they gate on the inline `import.meta.env` test).
 */
import {
  scheduleIndexSchema,
  schedulePaths,
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
