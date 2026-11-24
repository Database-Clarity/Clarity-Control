import { z } from 'zod';
import {
  globalRecordSchema,
} from '@clarity/core';
import { apiRequest } from './apiAuth';
import { errorMessage } from './http';
import type {
  GlobalResult,
  GlobalsService,
  GlobalsTransport,
} from './globals';

/** The Worker caps every globals response at 64 KiB (S2B limits.fileBytes). */
export const globalsResponseBytes = 65_536;

const head = z.string().regex(/^[a-f0-9]{40}$/);
const entryDelta = z.object({
  head,
  entry: globalRecordSchema,
  causeIds: z.array(z.string().max(128)).max(32),
  renameCompleted: z.literal(false).optional(),
  intentId: z.string().max(128).optional(),
});
/** W b0e6884f: commits that touched the entry record (30 per page), newest first. */
const historyPage = z.object({
  head,
  page: z.number().int().positive(),
  commits: z
    .array(
      z.object({
        commit: head,
        author: z.string().max(256).nullable(),
        login: z.string().max(128).nullable(),
        avatar: z.string().max(2048).nullable().optional(),
        date: z.string().max(64).nullable(),
        message: z.string().max(4096),
      }),
    )
    .max(30),
});
const historyVersion = z.object({
  head,
  commit: head,
  entry: globalRecordSchema,
});
export const globalHistoryPageSize = 30;
export type GlobalHistoryPage = z.infer<typeof historyPage>;
export type GlobalHistoryCommit = GlobalHistoryPage['commits'][number];
export type GlobalHistoryVersion = z.infer<typeof historyVersion>;
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
 * A 503 or a queued name check answers `retry` and
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
    return { kind: 'retry', message: errorMessage(error) };
  }
  if (response.status === 401) return { kind: 'forbidden', message: signIn };
  // A write that answered 2xx may have landed even when its reply is unreadable: say so.
  const unreadable = (message: string): GlobalResult<T> =>
    init?.method === 'POST' && response.ok
      ? { kind: 'retry', message: 'The save could not be confirmed. Refresh to check.' }
      : { kind: 'invalid', message };
  let text: string | undefined;
  try {
    text = await boundedText(response, globalsResponseBytes);
  } catch {
    return unreadable('The globals response was not valid text.');
  }
  if (text === undefined) return unreadable('The globals response is too large.');
  let parsed: z.infer<typeof envelope> | undefined;
  try {
    parsed = envelope.parse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed)
    return response.status >= 500
      ? { kind: 'retry', message: `The server answered HTTP ${response.status}.` }
      : unreadable(`Unexpected globals response (HTTP ${response.status}).`);
  if (parsed.kind !== 'ok') {
    const message =
      parsed.kind === 'retry' ? (parsed.message ?? 'Refresh and try again.') : (parsed.message ?? '');
    return { kind: parsed.kind, message: message || 'The globals request was refused.' };
  }
  if (!response.ok) return { kind: 'invalid', message: `Unexpected HTTP ${response.status}.` };
  const value = schema.safeParse(parsed.value);
  return value.success
    ? { kind: 'ok', value: value.data }
    : unreadable('The globals response did not match the expected shape.');
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function routeOf(mutation: Parameters<GlobalsService['mutate']>[0]['mutation']): string {
  if (mutation.operation === 'create') return '/globals';
  const action = mutation.operation === 'edit' ? 'body' : mutation.operation;
  return `/globals/${encodeURIComponent(mutation.id)}/${action}`;
}

export interface GlobalsHttpTransport extends GlobalsTransport {
  history(id: string, page: number): Promise<GlobalResult<GlobalHistoryPage>>;
  historyVersion(id: string, commit: string): Promise<GlobalResult<GlobalHistoryVersion>>;
}

/** Authenticated, bounded HTTP for the S3 GlobalsTransport contract (S2B handler shapes). */
export function createGlobalsHttpTransport(): GlobalsHttpTransport {
  return {
    entry: (id) => call(`/globals/${encodeURIComponent(id)}`, entryDelta),
    mutate: (request) => call(routeOf(request.mutation), entryDelta, post(request)),
    history: async (id, page) =>
      call(`/globals/${encodeURIComponent(id)}/history?page=${page}`, historyPage),
    historyVersion: async (id, commit) => {
      const result = await call(
        `/globals/${encodeURIComponent(id)}/history?commit=${encodeURIComponent(commit)}`,
        historyVersion,
      );
      return result.kind === 'ok' &&
        (result.value.commit !== commit || result.value.entry.id !== id)
        ? { kind: 'invalid', message: 'Global version names another entry or commit.' }
        : result;
    },
  };
}
