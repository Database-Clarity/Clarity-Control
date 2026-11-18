import { z } from 'zod';
import { validGlobalName, type GlobalRecord } from '../../../../packages/core/src/globals/model.js';
import { reservedNamePattern } from '../../../../packages/core/src/markup/braces.js';
import { extractBlocks, extractVariables } from '../../../../packages/core/src/markup/syntax.js';
import type { Lang } from '../../../../packages/core/src/languages.js';
import { blobContent, blobSha, RefRace } from '../github.js';
import { body, HttpError, json } from '../http.js';
import type { Access } from '../permissions.js';
import type { Identity } from '../types.js';
import {
  catalogSchema,
  clashSchema,
  destinationsSchema,
  entrySchema,
  globalFileBytes,
  limits,
  mutationSchema,
  nameProofRequestSchema,
  oid,
  pageSchema,
  pendingCauseSchema,
  paths,
  removalSchema,
  reviewPageSchema,
  retrySchema,
  rowSchema,
  sameSources,
  sourcesSchema,
  syncSchema,
  type Mutation,
  type Sources,
  type SyncState,
} from './model.js';
import { readGlobalFiles, type GlobalsStorage } from './storage.js';

/** S5 supplies this from ONE pinned authenticated read, not from client fields.
 * sources must be cheaply observed current tree/blob/ref identities (including all
 * consumers/config writers), not a previously stored version manifest. CAS is on head.
 * No resolver, corpus reads, fallback scans, or retry/rebase occurs here.
 */
export interface GlobalsContext {
  storage: GlobalsStorage;
  head: string;
  sources: Sources;
  access: Access;
  user: Identity;
  repository: string;
  /** Complete configured publication destinations, freshly observed by S5. */
  destinations: string[];
}

export async function namePaths(kind: string, name: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${name}`)),
  );
  const key = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    claim: `globals/names/${kind}/${key}.json`,
    proof: `globals/proofs/clashes/${kind}/${key}.json`,
  };
}

function bounded(value: unknown, maximum = limits.fileBytes): void {
  if (globalFileBytes(value) > maximum)
    throw new HttpError(413, 'Global metadata exceeds its byte limit');
}

function boundedResponse(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limits.fileBytes)
    throw new HttpError(413, 'Global response exceeds its byte limit');
}

function admission<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(422, 'Invalid global mutation');
  return result.data;
}

async function mutationBody(request: Request) {
  try {
    return await body(request, mutationSchema, limits.requestBytes);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400 && error.details !== undefined)
      throw new HttpError(422, 'Invalid global mutation');
    throw error;
  }
}

function syncView(sync: SyncState, causeIds = sync.causeIds) {
  return {
    status: causeIds.length ? sync.status : 'current',
    causeIds,
    // Never reflect producer error details, tooltip text, or upstream credentials.
    ...(causeIds.length && sync.lastFailure !== null
      ? { lastFailure: 'Sync failed. Retry sync.' }
      : {}),
  };
}

function snapshot(
  ctx: GlobalsContext,
  head: string,
  sync: SyncState,
  entries: GlobalRecord[],
  extraIds: string[] = [],
) {
  const ids = new Set([...entries.map((entry) => entry.id), ...extraIds]);
  const state = syncView(sync);
  return {
    head,
    entries,
    impacts: {},
    sync: Object.fromEntries(
      [...ids].map((id) => [
        id,
        syncView(
          sync,
          sync.causeIds.filter((cause) => sync.causeEntries[cause] === id),
        ),
      ]),
    ),
    destinationSync: Object.fromEntries(
      ctx.destinations.map((destination) => [destination, state]),
    ),
    // Also retained on the paged/delta envelope for simple transport clients.
    ...state,
    lastFailure: state.lastFailure ?? null,
  };
}

async function readFile<T>(ctx: GlobalsContext, path: string, schema: z.ZodType<T>) {
  const maximum =
    path === paths.sync ||
    path.startsWith('globals/entries/') ||
    path.startsWith('globals/reviews/')
      ? limits.entryBytes
      : limits.metadataBytes;
  const [file] = await readGlobalFiles(ctx.storage, [path], ctx.head, maximum);
  if (!file) throw new HttpError(503, 'Sync pending: required metadata is unavailable');
  const result = schema.safeParse(file.value);
  if (!result.success) throw new HttpError(503, 'Sync pending: invalid metadata');
  return { value: result.data, sha: file.sha };
}

async function read<T>(ctx: GlobalsContext, path: string, schema: z.ZodType<T>): Promise<T> {
  return (await readFile(ctx, path, schema)).value;
}

function currentProof(proof: { sources: Sources }, ctx: GlobalsContext): void {
  if (!sameSources(proof.sources, ctx.sources))
    throw new HttpError(503, 'Sync pending: source proof is stale; retry after sync');
}

function permit(ctx: GlobalsContext, roles: Access['role'][], lang?: Lang) {
  if (
    !roles.includes(ctx.access.role) ||
    (ctx.access.role === 'translator' &&
      lang !== undefined &&
      (lang === 'en' || !ctx.access.languages?.includes(lang)))
  )
    throw new HttpError(403, 'Permission denied');
}

function validName(kind: GlobalRecord['kind'], name: string) {
  if (!validGlobalName(kind, name) || (kind === 'variables' && reservedNamePattern.test(name)))
    throw new HttpError(422, 'Invalid or protected global name');
}

function declaration(kind: GlobalRecord['kind'], name: string, value: string): string {
  const block = kind === 'exports' ? 'export' : 'title';
  const text =
    kind === 'variables' ? `var ${name} = ${value || 'empty'}` : `${block} ${name} (\n${value}\n)`;
  const parsed = kind === 'variables' ? extractVariables(text) : extractBlocks(text, block);
  if (
    /[\r]/.test(value) ||
    (kind === 'variables' && /\n/.test(value)) ||
    (kind !== 'variables' && !value.trim()) ||
    parsed[name] !== value ||
    // Comment delimiters would change the declaration after resolver preparation.
    /\/\*|\*\/|(^|\s)\/\//.test(value)
  )
    throw new HttpError(422, 'Body cannot round-trip through the declaration grammar');
  if (kind === 'variables' && name === 'e' && value !== '🡅')
    throw new HttpError(422, 'The enhanced arrow is protected');
  return text;
}

async function admitName(
  ctx: GlobalsContext,
  kind: GlobalRecord['kind'],
  name: string,
  id: string | null,
  requestable = false,
) {
  validName(kind, name);
  const locations = await namePaths(kind, name);
  const [file] = await readGlobalFiles(
    ctx.storage,
    [locations.proof],
    ctx.head,
    limits.metadataBytes,
  );
  if (!file) {
    if (requestable) return null;
    throw new HttpError(503, 'Sync pending: required metadata is unavailable');
  }
  const parsedProof = clashSchema.safeParse(file.value);
  if (!parsedProof.success) throw new HttpError(503, 'Sync pending: invalid metadata');
  const proof = parsedProof.data;
  if (!sameSources(proof.sources, ctx.sources)) {
    if (requestable) return null;
    currentProof(proof, ctx);
  }
  if (proof.kind !== kind || proof.name !== name || proof.occupiedBy !== id)
    throw new HttpError(409, 'Global name is occupied or its proof does not match');
  const [claim] = await readGlobalFiles(
    ctx.storage,
    [locations.claim],
    ctx.head,
    limits.metadataBytes,
  );
  // Proof certifies absence, while the CAS claim protects uniqueness across pending saves.
  if (claim) {
    const parsed = z
      .object({
        id: entrySchema.shape.id,
        kind: entrySchema.shape.kind,
        name: z.string(),
        intentId: z.string().optional(),
      })
      .strict()
      .safeParse(claim.value);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.kind !== kind ||
      parsed.data.name !== name ||
      parsed.data.intentId
    )
      throw new HttpError(409, 'Global name is reserved');
  } else if (id !== null) throw new HttpError(503, 'Sync pending: missing global name claim');
  return locations;
}

async function requestNameProof(
  ctx: GlobalsContext,
  operation: 'create' | 'rename',
  kind: GlobalRecord['kind'],
  name: string,
  before: GlobalRecord | null,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const request = nameProofRequestSchema.parse({
    version: 1,
    type: 'name-proof',
    id: requestId,
    operation,
    kind,
    name,
    globalId: before?.id ?? null,
    revision: before?.revision ?? null,
    expectedHead: ctx.head,
    sources: ctx.sources,
    by: ctx.user.login,
    at: new Date().toISOString(),
  });
  bounded(request, limits.metadataBytes);
  const head = await ctx.storage.commit(
    ctx.head,
    {
      [`globals/retries/${requestId}.json`]: request,
    },
    'Request current global name proof',
    ctx.user,
  );
  // A retry result preserves the client's unsaved mutation. Only proof work was queued;
  // the unchanged source does not create an impact cause or block another destination.
  return json(
    {
      kind: 'retry',
      message: 'Sync pending',
      status: 'sync-pending',
      head,
      proofRequestId: requestId,
      mutationCompleted: false,
      ...(operation === 'rename' ? { renameCompleted: false } : {}),
    },
    202,
  );
}

async function acknowledge(
  ctx: GlobalsContext,
  mutation: Extract<Mutation, { operation: 'acknowledge' }>,
  sync: SyncState,
) {
  if (sync.status !== 'current')
    throw new HttpError(409, 'Sync pending: saved rows cannot be acknowledged');
  const row = await read(ctx, paths.row(mutation.consumerId), rowSchema);
  currentProof(row, ctx);
  permit(ctx, ['editor', 'maintainer', 'translator'], row.review.consumer.lang);
  if (
    row.id !== mutation.consumerId ||
    !row.review.causes.some((c) => c.globalId === mutation.id) ||
    row.review.contentDigest !== mutation.contentDigest ||
    row.review.dependencyDigest !== mutation.dependencyDigest ||
    row.impactDigest !== mutation.impactDigest
  )
    throw new HttpError(409, 'The saved review is stale');
  const previousAudit = row.review.acknowledgement;
  if (
    previousAudit &&
    previousAudit.contentDigest === row.review.contentDigest &&
    previousAudit.dependencyDigest === row.review.dependencyDigest &&
    previousAudit.impactDigest === row.impactDigest
  )
    throw new HttpError(409, 'The saved review is already acknowledged');
  const next = {
    ...row,
    review: {
      ...row.review,
      acknowledgement: {
        by: ctx.user.login,
        at: new Date().toISOString(),
        contentDigest: row.review.contentDigest,
        dependencyDigest: row.review.dependencyDigest,
        impactDigest: row.impactDigest,
        decision: mutation.decision,
      },
    },
  };
  admission(rowSchema, next);
  bounded(next, limits.entryBytes);
  const entry = await read(ctx, paths.entry(mutation.id), entrySchema);
  if (entry.id !== mutation.id) throw new HttpError(503, 'Invalid global identity');
  const result = {
    ...snapshot(ctx, ctx.head, sync, [entry]),
    consumerId: row.id,
    review: next.review,
  };
  boundedResponse(result);
  const head = await ctx.storage.commit(
    ctx.head,
    { [paths.row(row.id)]: next },
    'Acknowledge global dependency review',
    ctx.user,
  );
  return { ...result, head };
}

async function retry(ctx: GlobalsContext, input: z.infer<typeof retrySchema>, sync: SyncState) {
  if (input.expectedHead !== ctx.head) throw new HttpError(409, 'Source head changed');
  if (
    sync.status === 'current' ||
    input.causeIds.some((id) => !sync.causeIds.includes(id) || sync.causeEntries[id] !== input.id)
  )
    throw new HttpError(409, 'Sync causes changed; refresh before retrying');
  const entry = await read(ctx, paths.entry(input.id), entrySchema);
  if (entry.id !== input.id) throw new HttpError(503, 'Invalid global identity');
  const files = await readGlobalFiles(
    ctx.storage,
    input.causeIds.map((id) => `globals/causes/${id}.json`),
    ctx.head,
    4096,
  );
  for (let i = 0; i < files.length; i++) {
    const cause = pendingCauseSchema.safeParse(files[i]?.value);
    if (!cause.success) throw new HttpError(503, 'Sync pending: durable cause is unavailable');
    if (cause.data.id !== input.causeIds[i] || cause.data.globalId !== input.id)
      throw new HttpError(409, 'Sync cause identity changed');
    if (ctx.access.role === 'translator' && cause.data.lang === null)
      throw new HttpError(403, 'Permission denied');
    permit(
      ctx,
      cause.data.operation === 'remove'
        ? ['maintainer']
        : cause.data.operation === 'rename'
          ? ['editor', 'maintainer']
          : cause.data.operation === 'create'
            ? ['trial', 'editor', 'maintainer']
            : ['trial', 'editor', 'maintainer', 'translator'],
      cause.data.lang ?? undefined,
    );
  }
  const requestId = crypto.randomUUID();
  const pending: SyncState = { ...sync, status: 'sync-pending' };
  const request = {
    version: 1,
    id: requestId,
    globalId: input.id,
    causeIds: input.causeIds,
    expectedHead: ctx.head,
    sources: ctx.sources,
    by: ctx.user.login,
    at: new Date().toISOString(),
  };
  bounded(request);
  const result = {
    ...snapshot(ctx, ctx.head, pending, [entry]),
    retryId: requestId,
    message: 'Sync pending',
  };
  boundedResponse(result);
  const head = await ctx.storage.commit(
    ctx.head,
    {
      [`globals/retries/${requestId}.json`]: request,
      [paths.sync]: pending,
    },
    'Requeue durable global sync causes',
    ctx.user,
  );
  return { ...result, head };
}

async function mutate(ctx: GlobalsContext, mutation: Mutation, sync: SyncState) {
  if (mutation.operation === 'acknowledge') return acknowledge(ctx, mutation, sync);
  const lang = 'lang' in mutation ? mutation.lang : undefined;
  permit(
    ctx,
    mutation.operation === 'remove'
      ? ['maintainer']
      : mutation.operation === 'rename'
        ? ['editor', 'maintainer']
        : mutation.operation === 'create'
          ? ['trial', 'editor', 'maintainer']
          : ['trial', 'editor', 'maintainer', 'translator'],
    lang,
  );
  if (sync.causeIds.length >= limits.causes)
    throw new HttpError(503, 'Sync pending: wait for sync before saving again');
  const id = mutation.operation === 'create' ? `g_${crypto.randomUUID()}` : mutation.id;
  const beforeFile =
    mutation.operation === 'create' ? null : await readFile(ctx, paths.entry(id), entrySchema);
  const before = beforeFile?.value ?? null;
  if (before && (before.id !== id || before.tombstone))
    throw new HttpError(409, 'Global entry is unavailable');
  if (before && mutation.operation !== 'create' && before.revision !== mutation.revision)
    throw new HttpError(409, 'Global revision changed');
  const next: GlobalRecord =
    mutation.operation === 'create'
      ? {
          version: 1,
          id,
          kind: mutation.kind,
          name: mutation.name,
          revision: crypto.randomUUID(),
          definitions: {},
          nameHistory: [],
        }
      : structuredClone(before!);
  const revision = crypto.randomUUID(),
    causeId = crypto.randomUUID(),
    at = new Date().toISOString();
  const files: Record<string, unknown> = {};
  let intentId: string | undefined;
  if (mutation.operation === 'rename') {
    if (before!.kind === 'variables' && before!.name === 'e')
      throw new HttpError(422, 'The enhanced arrow is protected');
    if (mutation.name === before!.name) throw new HttpError(422, 'Name is unchanged');
    const locations = await admitName(ctx, next.kind, mutation.name, null, true);
    if (!locations) return requestNameProof(ctx, 'rename', next.kind, mutation.name, before);
    intentId = causeId;
    files[locations.claim] = { id, kind: next.kind, name: mutation.name, intentId };
    files[`globals/intents/${intentId}.json`] = {
      version: 1,
      id: intentId,
      operation: 'rename',
      globalId: id,
      revision: before!.revision,
      expectedHead: ctx.head,
      sources: ctx.sources,
      name: mutation.name,
      by: ctx.user.login,
      at,
    };
  } else {
    if (mutation.operation === 'remove') {
      if (before!.kind === 'variables' && before!.name === 'e')
        throw new HttpError(422, 'The enhanced arrow is protected');
      if (mutation.lang && !before!.definitions[mutation.lang])
        throw new HttpError(422, 'Language definition is absent');
      const proof = await read(ctx, paths.removal(id, mutation.lang), removalSchema);
      currentProof(proof, ctx);
      if (
        proof.id !== id ||
        proof.revision !== before!.revision ||
        proof.lang !== (mutation.lang ?? null)
      )
        throw new HttpError(503, 'Sync pending: removal proof does not match');
      if (mutation.lang) delete next.definitions[mutation.lang];
      else next.tombstone = { by: ctx.user.login, at };
    } else {
      declaration(next.kind, next.name, mutation.body);
      const locations = await admitName(
        ctx,
        next.kind,
        next.name,
        before ? id : null,
        mutation.operation === 'create',
      );
      if (!locations) return requestNameProof(ctx, 'create', next.kind, next.name, null);
      files[locations.claim] = { id, kind: next.kind, name: next.name };
      const previous = next.definitions[mutation.lang];
      next.definitions[mutation.lang] = {
        body: mutation.body,
        revision,
        updatedAt: at,
        updatedBy: ctx.user.login,
        ...(mutation.lang !== 'en' && next.definitions.en
          ? {
              sourceRevision: next.definitions.en.revision,
              sourceUpdatedAt: next.definitions.en.updatedAt,
            }
          : {}),
        // S1 c2cf5074 makes migration ancestry optional for post-migration cells.
        // Preserve real ancestry; never invent it for a new definition or language.
        ...(previous?.provenance ? { provenance: previous.provenance } : {}),
      };
    }
    next.revision = revision;
    admission(entrySchema, next);
    bounded(next, limits.entryBytes);
    files[paths.entry(id)] = next;
    files[`globals/projections/${id}.json`] = {
      version: 1,
      entryId: id,
      revision,
      operation: mutation.operation,
      lang: lang ?? null,
      status: 'sync-pending',
    };
    if (mutation.operation === 'create') {
      const catalog = await read(ctx, 'globals/catalog.json', catalogSchema);
      const cursor = `p${catalog.lastPage}`;
      const page = await read(ctx, paths.page(cursor), pageSchema);
      if (page.nextCursor !== null) throw new HttpError(503, 'Invalid global catalog tail');
      if (page.ids.length < limits.page)
        files[paths.page(cursor)] = { ...page, ids: [...page.ids, id] };
      else {
        if (catalog.lastPage >= 99999) throw new HttpError(422, 'Global catalog is full');
        const nextCursor = `p${catalog.lastPage + 1}`;
        files[paths.page(cursor)] = { ...page, nextCursor };
        files[paths.page(nextCursor)] = { version: 1, ids: [id], nextCursor: null };
        files['globals/catalog.json'] = { ...catalog, lastPage: catalog.lastPage + 1 };
      }
    }
  }
  // Every immutable cause survives consecutive saves; S4 alone drains the durable list.
  // Blob IDs pin exact before/after entry bytes without hashing or loading a corpus.
  files[`globals/causes/${causeId}.json`] = pendingCauseSchema.parse({
    version: 1,
    id: causeId,
    operation: mutation.operation,
    globalId: id,
    lang: lang ?? null,
    beforeSources: ctx.sources,
    expectedHead: ctx.head,
    at,
    by: ctx.user.login,
    before: before
      ? { path: paths.entry(id), blob: beforeFile!.sha, revision: before.revision }
      : null,
    after: {
      path: paths.entry(id),
      blob: intentId ? beforeFile!.sha : await blobSha(blobContent(next)),
      revision: next.revision,
    },
    intentId: intentId ?? null,
  });
  bounded(files[`globals/causes/${causeId}.json`], 4096);
  const pending: SyncState = {
    version: 1,
    status: 'sync-pending',
    causeIds: [...sync.causeIds, causeId],
    causeEntries: { ...sync.causeEntries, [causeId]: id },
    lastFailure: sync.lastFailure,
  };
  files[paths.sync] = pending;
  for (const file of Object.values(files)) bounded(file);
  const result = {
    ...snapshot(ctx, ctx.head, pending, [next]),
    message: 'Sync pending',
    entry: next,
    ...(intentId ? { intentId, renameCompleted: false } : {}),
  };
  boundedResponse(result);
  const head = await ctx.storage.commit(
    ctx.head,
    files,
    'Save global entry with Sync pending cause',
    ctx.user,
  );
  return { ...result, head };
}

/** Exported for S5 routing. load() must authenticate, refresh permissions, and observe
 * all source identities on EVERY call, including read, retry, and acknowledgement.
 */
export async function globalsHandler(
  request: Request,
  load: () => Promise<GlobalsContext>,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route =
      /^\/globals(?:\/(g_[a-zA-Z0-9_-]{8,80})(?:\/(body|rename|remove|acknowledge|reviews|retry))?)?$/.exec(
        url.pathname,
      );
    if (!route) throw new HttpError(404, 'Global route not found');
    const ctx = await load();
    oid.parse(ctx.head);
    sourcesSchema.parse(ctx.sources);
    destinationsSchema.parse(ctx.destinations);
    z.string().min(1).max(128).parse(ctx.user.login);
    permit(ctx, ['trial', 'translator', 'editor', 'maintainer']);
    const sync = await read(ctx, paths.sync, syncSchema);
    if (request.method === 'POST' && route[2] === 'retry') {
      const input = await body(request, retrySchema, limits.requestBytes);
      if (input.id !== route[1]) throw new HttpError(400, 'Route and retry identity do not match');
      return json({ kind: 'ok', value: await retry(ctx, input, sync) });
    }
    if (request.method === 'GET' && route[2] === 'reviews') {
      const cursor = url.searchParams.get('cursor') ?? 'p0';
      if (!/^p\d{1,5}$/.test(cursor)) throw new HttpError(400, 'Invalid review page');
      const page = await read(
        ctx,
        `globals/review-pages/${route[1]}/${cursor}.json`,
        reviewPageSchema,
      );
      currentProof(page, ctx);
      const consumers = [];
      for (const id of page.ids) {
        const row = await read(ctx, paths.row(id), rowSchema);
        currentProof(row, ctx);
        if (row.id !== id || !row.review.causes.some((c) => c.globalId === route[1]))
          throw new HttpError(503, 'Invalid global review page');
        consumers.push({ ...row.view, id, review: row.review, impactDigest: row.impactDigest });
      }
      const value = {
        ...snapshot(ctx, ctx.head, sync, [], [route[1]]),
        impacts: { [route[1]]: consumers },
        nextCursor: page.nextCursor,
      };
      boundedResponse(value);
      return json({ kind: 'ok', value });
    }
    if (request.method === 'GET' && !route[2]) {
      if (route[1]) {
        const entry = await read(ctx, paths.entry(route[1]), entrySchema);
        if (entry.id !== route[1]) throw new HttpError(503, 'Invalid global identity');
        const value = { ...snapshot(ctx, ctx.head, sync, [entry]), entry };
        boundedResponse(value);
        return json({ kind: 'ok', value });
      }
      const cursor = url.searchParams.get('cursor') ?? 'p0';
      if (!/^p\d{1,5}$/.test(cursor)) throw new HttpError(400, 'Invalid global page');
      const page = await read(ctx, paths.page(cursor), pageSchema);
      const files = await readGlobalFiles(
        ctx.storage,
        page.ids.map(paths.entry),
        ctx.head,
        limits.entryBytes,
      );
      const entries = files.map((file, i) => {
        if (!file) throw new HttpError(503, 'Global page entry is missing');
        bounded(file.value, limits.entryBytes);
        const entry = entrySchema.parse(file.value);
        if (entry.id !== page.ids[i]) throw new HttpError(503, 'Invalid global identity');
        return entry;
      });
      const value = { ...snapshot(ctx, ctx.head, sync, entries), nextCursor: page.nextCursor };
      boundedResponse(value);
      return json({ kind: 'ok', value });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const input = await mutationBody(request);
    if (input.expectedHead !== ctx.head) throw new HttpError(409, 'Source head changed');
    const action = input.mutation.operation;
    if (
      action === 'create'
        ? Boolean(route[1])
        : route[1] !== input.mutation.id || route[2] !== (action === 'edit' ? 'body' : action)
    )
      throw new HttpError(400, 'Route and mutation do not match');
    const result = await mutate(ctx, input.mutation, sync);
    return result instanceof Response ? result : json({ kind: 'ok', value: result });
  } catch (error) {
    if (error instanceof RefRace)
      return json({ kind: 'conflict', message: 'Source head changed' }, 409);
    if (error instanceof z.ZodError)
      return json({ kind: 'retry', message: 'Sync pending: invalid metadata' }, 503);
    if (!(error instanceof HttpError)) throw error;
    const type =
      error.status === 403
        ? 'forbidden'
        : error.status === 409
          ? 'conflict'
          : error.status === 503
            ? 'retry'
            : 'invalid';
    return json({ kind: type, message: error.message }, error.status);
  }
}
