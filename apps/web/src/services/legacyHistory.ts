import { languages, type Tooltip } from '@clarity/core';
import { z } from 'zod';
import type { HistoryCommit } from './history';
import type { RevisionCache } from '../features/history/revisions';

// Frozen artifact commit; publication requires independent data verification.
export const legacyHistoryCommit = 'ca7d872d64512bc9ecba094dac6e368f65e1fea5';
const source = `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/${legacyHistoryCommit}`;
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const revisionSchema = z.object({
  commit: sha,
  author: z.string(),
  date: z.string().datetime({ offset: true }),
  message: z.string(),
  text: z.partialRecord(z.enum(languages), z.string()).nullable(),
});
export const legacyHistorySchema = z.object({
  schemaVersion: z.literal(1),
  hash: z.number().int().nonnegative(),
  cutoff: sha,
  mappingCommit: sha,
  lanes: z
    .array(
      z.object({
        hash: z.number().int(),
        sourceHash: z.number().int(),
        verified: z.boolean(),
        revisions: z.array(revisionSchema).max(1000),
      }),
    )
    .max(32),
});
export type LegacyHistory = z.infer<typeof legacyHistorySchema>;
export type LegacyLane = LegacyHistory['lanes'][number];
const cache = new Map<number, Promise<LegacyHistory | null>>();
const requests = new Map<number, { controller: AbortController; consumers: number }>();

/** Public immutable artifacts, requested only by mounted/open history content. */
export function getLegacyHistory(
  hash: number,
  signal?: AbortSignal,
): Promise<LegacyHistory | null> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  const subscribe = (promise: Promise<LegacyHistory | null>) => {
    const pending = requests.get(hash);
    if (!pending) return promise;
    pending.consumers++;
    // A consumer without a cancellation signal still owns its shared request.
    if (!signal) return promise;
    const abort = () => {
      if (--pending.consumers === 0 && requests.get(hash) === pending) {
        pending.controller.abort();
        requests.delete(hash);
        cache.delete(hash);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
    return promise;
  };
  const found = cache.get(hash);
  if (found) {
    cache.delete(hash);
    cache.set(hash, found);
    return subscribe(found);
  }
  const controller = new AbortController();
  const pending = { controller, consumers: 0 };
  requests.set(hash, pending);
  const request = (async () => {
    const response = await fetch(`${source}/${hash}.json`, {
      credentials: 'omit',
      cache: 'force-cache',
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Published history is temporarily unavailable.');
    const raw = await response.text();
    if (raw.length > 131072) throw new Error('Published history exceeds the supported size.');
    const value = legacyHistorySchema.parse(JSON.parse(raw));
    if (
      value.hash !== hash ||
      value.lanes.some((lane) => lane.hash !== hash || (lane.verified && lane.sourceHash !== hash))
    )
      throw new Error('Published history identity mismatch.');
    return value;
  })();
  cache.set(hash, request);
  while (cache.size > 12) cache.delete(cache.keys().next().value!);
  void request
    .finally(() => {
      if (requests.get(hash) === pending) requests.delete(hash);
    })
    .catch(() => {
      if (cache.get(hash) === request) cache.delete(hash);
    });
  return subscribe(request);
}

export function legacyTooltip(
  hash: number,
  revision: LegacyLane['revisions'][number],
): Tooltip | null {
  if (revision.text === null) return null;
  return {
    hash,
    associated: [],
    text: Object.fromEntries(
      Object.entries(revision.text).map(([lang, text]) => [
        lang,
        { text, updatedAt: revision.date, updatedBy: revision.author },
      ]),
    ),
  };
}

/** Adapt immutable local artifacts to the existing accessible history popover. */
export function legacyRevisionCache(lane: LegacyLane): RevisionCache {
  const commits: HistoryCommit[] = [...lane.revisions].reverse().map((entry) => ({
    commit: entry.commit,
    author: entry.author,
    date: entry.date,
    message: entry.message,
  }));
  const versions = new Map(
    lane.revisions.map((revision) => [revision.commit, legacyTooltip(lane.hash, revision)]),
  );
  return {
    identity: -lane.sourceHash,
    version: async (commit) => versions.get(commit) ?? null,
    page: async () => commits,
    peekPage: () => commits,
    async load(entries, index) {
      const next = entries[index - 1];
      return {
        revision: versions.get(entries[index].commit) ?? null,
        previous: next ? (versions.get(next.commit) ?? null) : null,
        hasPredecessor: Boolean(next),
      };
    },
  };
}
