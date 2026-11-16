import { z } from 'zod';
import {
  globalIdSchema,
  globalImpactRowSchema,
  globalRecordSchema,
  globalReviewSchema,
  langSchema,
} from '@clarity/core';
import { apiRequest } from './apiAuth';
import { errorMessage } from './http';
import type {
  GlobalAuditDelta,
  GlobalEntryDelta,
  GlobalEntryPage,
  GlobalHttpState,
  GlobalResult,
  GlobalReviewPage,
  GlobalsService,
  GlobalsTransport,
} from './globals';

/** The Worker caps every globals response at 64 KiB (S2B limits.fileBytes). */
export const globalsResponseBytes = 65_536;

const header = {
  head: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.enum(['sync-pending', 'sync-failed', 'current']),
  causeIds: z.array(z.string().max(128)).max(32),
  lastFailure: z.string().max(512).nullable().optional(),
};
const entryPage = z.object({
  ...header,
  entries: z.array(globalRecordSchema).max(3),
  nextCursor: z.string().nullable(),
});
const entryDelta = z.object({ ...header, entry: globalRecordSchema });
const consumer = globalImpactRowSchema.extend({
  id: z.string().max(128),
  variant: z.number().int().nonnegative(),
  name: z.string().max(256),
  category: z.string().max(128),
  line: z.number().int().positive().nullable(),
  path: z.array(z.string().max(128)).max(32).nullable(),
  direct: z.boolean().nullable(),
  archived: z.boolean(),
  beforeSource: z.string().max(8192),
  afterSource: z.string().max(8192),
  review: globalReviewSchema,
  impactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const reviewPage = z.object({
  ...header,
  impacts: z.record(globalIdSchema, z.array(consumer).max(3)),
  nextCursor: z.string().nullable(),
});
const mutationDelta = z.union([
  z.object({
    ...header,
    entry: globalRecordSchema,
    renameCompleted: z.literal(false).optional(),
    intentId: z.string().max(128).optional(),
  }),
  z.object({ ...header, consumerId: z.string().max(128), review: globalReviewSchema }),
]);
const retryDelta = z.object({ ...header, entries: z.tuple([globalRecordSchema]) });
const historyPage = z.object({
  ...header,
  versions: z
    .array(
      z.object({
        revision: z.string().max(128),
        at: z.string().max(64),
        by: z.string().max(128),
        operation: z.enum(['create', 'edit', 'rename', 'remove', 'restore']),
        lang: langSchema.nullable(),
        name: z.string().max(128),
        body: z.string().max(8192).nullable(),
      }),
    )
    .max(3),
  nextCursor: z.string().nullable(),
});
export type GlobalHistoryVersion = z.infer<typeof historyPage>['versions'][number];
export type GlobalHistoryPage = GlobalHttpState & {
  versions: GlobalHistoryVersion[];
  nextCursor: string | null;
};
const envelope = z.object({
  kind: z.enum(['ok', 'conflict', 'retry', 'invalid', 'forbidden']),
  value: z.unknown().optional(),
  message: z.string().max(512).optional(),
});

/** Reads at most `limit` bytes; a longer body is refused before JSON.parse ever sees it. */
async function boundedText(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const signIn = 'Sign in again to edit globals.';

/**
 * One request, never repeated: a 503 or a queued name proof answers `retry` ("Sync pending") and
 * the person decides when to try again (S3/S5 ruling: no automatic mutation retries).
 */
async function call<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<GlobalResult<T>> {
  let response: Response;
  try {
    response = await apiRequest(path, init);
  } catch (error) {
    // The outcome is unknown, not failed: Refresh shows whether the change landed.
    return { kind: 'retry', message: `Sync pending: ${errorMessage(error)}` };
  }
  if (response.status === 401) return { kind: 'forbidden', message: signIn };
  let text: string | undefined;
  try {
    text = await boundedText(response, globalsResponseBytes);
  } catch {
    return { kind: 'invalid', message: 'The globals response was not valid text.' };
  }
  if (text === undefined) return { kind: 'invalid', message: 'The globals response is too large.' };
  let parsed: z.infer<typeof envelope> | undefined;
  try {
    parsed = envelope.parse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed)
    return response.status >= 500
      ? { kind: 'retry', message: `Sync pending: the server answered HTTP ${response.status}.` }
      : { kind: 'invalid', message: `Unexpected globals response (HTTP ${response.status}).` };
  if (parsed.kind !== 'ok') {
    const message =
      parsed.kind === 'retry' ? (parsed.message ?? 'Sync pending') : (parsed.message ?? '');
    return { kind: parsed.kind, message: message || 'The globals request was refused.' };
  }
  if (!response.ok) return { kind: 'invalid', message: `Unexpected HTTP ${response.status}.` };
  const value = schema.safeParse(parsed.value);
  return value.success
    ? { kind: 'ok', value: value.data }
    : { kind: 'invalid', message: 'The globals response did not match the expected shape.' };
}

const http = <T extends { lastFailure?: string | null }>(value: T) => ({
  ...value,
  version: 1 as const,
  lastFailure: value.lastFailure ?? null,
});
const map = <A, B>(result: GlobalResult<A>, next: (value: A) => B): GlobalResult<B> =>
  result.kind === 'ok' ? { kind: 'ok', value: next(result.value) } : result;
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const cursorQuery = (cursor: string) => `?cursor=${encodeURIComponent(cursor)}`;

function routeOf(mutation: Parameters<GlobalsService['mutate']>[0]['mutation']): string {
  if (mutation.operation === 'create') return '/globals';
  const action = mutation.operation === 'edit' ? 'body' : mutation.operation;
  return `/globals/${encodeURIComponent(mutation.id)}/${action}`;
}

export interface GlobalsHttpTransport extends GlobalsTransport {
  history(id: string, cursor: string): Promise<GlobalResult<GlobalHistoryPage>>;
}

/** Authenticated, bounded HTTP for the S3 GlobalsTransport contract (S2B handler shapes). */
export function createGlobalsHttpTransport(): GlobalsHttpTransport {
  return {
    list: async (cursor) =>
      map(await call(`/globals${cursorQuery(cursor)}`, entryPage), (value): GlobalEntryPage =>
        http(value),
      ),
    entry: async (id) =>
      map(await call(`/globals/${encodeURIComponent(id)}`, entryDelta), (value): GlobalEntryDelta =>
        http(value),
      ),
    reviews: async (id, cursor) => {
      const result = await call(
        `/globals/${encodeURIComponent(id)}/reviews${cursorQuery(cursor)}`,
        reviewPage,
      );
      if (result.kind !== 'ok') return result;
      const { impacts, ...rest } = result.value;
      const keys = Object.keys(impacts);
      if (keys.length !== 1 || keys[0] !== id)
        return { kind: 'invalid', message: 'Global review page names another entry.' };
      return {
        kind: 'ok',
        value: { ...http(rest), consumers: impacts[id] } as GlobalReviewPage,
      };
    },
    mutate: async (request) =>
      map(
        await call(routeOf(request.mutation), mutationDelta, post(request)),
        (value): GlobalEntryDelta | GlobalAuditDelta => http(value) as GlobalEntryDelta,
      ),
    retrySync: async (request) =>
      map(
        await call(`/globals/${encodeURIComponent(request.id)}/retry`, retryDelta, post(request)),
        ({ entries, ...value }): GlobalEntryDelta => ({ ...http(value), entry: entries[0] }),
      ),
    history: async (id, cursor) =>
      map(
        await call(`/globals/${encodeURIComponent(id)}/history${cursorQuery(cursor)}`, historyPage),
        (value): GlobalHistoryPage => http(value),
      ),
  };
}
