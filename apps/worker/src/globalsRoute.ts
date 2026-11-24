import { z } from 'zod';
import {
  emptyGitTree,
  globalConfigIdentity,
  globalSourcePaths,
  globalsConfigWithoutMarks,
  globalsReleasePaths,
  observeGlobalSources,
  permissionsSchema,
  type GlobalSources,
  type Permissions,
} from '@clarity/core';
import { RefRace, rawReadFailure, type GitHub } from './github.js';
import { HttpError, json } from './http.js';
import { requireAccess, type Access } from './permissions.js';
import { historySchema } from './history.js';
import {
  entrySchema,
  globalsHandler,
  limits,
  type GlobalsContext,
  type GlobalsStorage,
} from './globals/index.js';
import type { Identity } from './types.js';

/**
 * Global entries stay INACTIVE until the owner-gated G1 bootstrap, G2 install, and G3
 * activation. Off: every /globals route is 503 before authentication.
 */
export const globalsSwitch = { enabled: (): boolean => true };
export const isGlobalsPath = (path: string) => path === '/globals' || path.startsWith('/globals/');
export function refuseGlobalsWhenOff(): void {
  if (!globalsSwitch.enabled()) throw new HttpError(503, 'Global entries are not enabled');
}

const anyRole = ['trial', 'translator', 'editor', 'maintainer'] as const;

/** Contract v1: one destination, the configured held publication branch. */
export const globalDestinations = (github: GitHub) => [github.env.LIVE_BRANCH];

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const pinSchema = z.object({ sourceSha: oid, capabilities: z.array(z.string()) }).passthrough();
const installedMetadataSchema = z
  .object({ version: z.literal(1), configOid: oid, generatorSha: oid })
  .strict();
const decoder = new TextDecoder('utf-8', { fatal: true });
const incomplete = () => new HttpError(503, 'Sync pending: global metadata is incomplete');

function parseRaw(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw rawReadFailure();
  }
}

/**
 * ONE current authenticated observation (contract v1): permissions, PIN, and every source
 * identity come from the same data head; trees and blobs are actual Git OIDs, never a
 * stored manifest. Missing optional trees use the empty-tree OID; a missing layout,
 * destination store, authored/config tree, installed config, or live branch fails closed.
 */
export async function observeGlobals(
  github: GitHub,
  user?: Identity,
): Promise<{ head: string; sources: GlobalSources; access: Access | null }> {
  const destination = globalDestinations(github)[0]!;
  let observed: Awaited<ReturnType<GitHub['globalObservation']>>;
  try {
    observed = await github.globalObservation(
      [
        globalSourcePaths.authored,
        globalSourcePaths.definitions,
        globalSourcePaths.projections,
        globalSourcePaths.config,
        globalSourcePaths.upcoming,
      ],
      [
        globalsReleasePaths.layout,
        globalsReleasePaths.published(destination),
        globalSourcePaths.aliasGroups,
        globalSourcePaths.sandboxPointers,
        '.publisher/config.json',
      ],
      ['config/permissions.json', '.publisher/PIN', '.publisher/installed.json'],
      262_144,
      globalSourcePaths.config,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 503) throw error;
    throw rawReadFailure();
  }
  const [authored, definitions, projections, config, upcoming] = observed.trees;
  const [layout, published, aliasGroups, sandboxPointers, installed] = observed.blobs;
  const [permissionsFile, pinFile, installedFile] = observed.texts;
  if (!permissionsFile) throw new HttpError(502, 'Required repository file is missing');
  const permissions: Permissions = permissionsSchema.parse(parseRaw(permissionsFile.bytes));
  // Authorize at THIS head before revealing anything about global metadata.
  const access = user ? requireAccess(permissions, user, [...anyRole]) : null;
  if (!authored || !config || !layout || !published || !installed || !observed.live)
    throw incomplete();
  const pin = pinFile ? pinSchema.safeParse(parseRaw(pinFile.bytes)) : undefined;
  if (!pin?.success || !pin.data.capabilities.includes('globalsRelease'))
    throw new HttpError(503, 'Sync pending: installed publisher lacks globalsRelease');
  if (!pin.data.capabilities.includes('globalsExportsV1'))
    throw new HttpError(503, 'Sync pending: installed publisher lacks globalsExportsV1');
  // The installer writes this small binding alongside the exact config bytes. Observe
  // both at this head: changing config without reinstalling must fail closed. Avoid
  // downloading and parsing the multi-megabyte config on each fresh Worker isolate.
  if (!installedFile || installedFile.bytes.byteLength > 1024) throw incomplete();
  const metadata = installedMetadataSchema.safeParse(parseRaw(installedFile.bytes));
  if (!metadata.success || metadata.data.configOid !== installed) throw incomplete();
  const configIdentity = pin.data.capabilities.includes(globalsConfigWithoutMarks)
    ? await globalConfigIdentity(observed.configEntries, config).catch(() => {
        throw rawReadFailure();
      })
    : config;
  const sources = await observeGlobalSources({
    authored,
    definitions: definitions ?? emptyGitTree,
    projections: projections ?? emptyGitTree,
    layout,
    published,
    config: configIdentity,
    live: observed.live,
    upcoming: upcoming ?? emptyGitTree,
    aliasGroups,
    sandboxPointers,
    generator: metadata.data.generatorSha,
    resolverRevision: pin.data.sourceSha,
  });
  return { head: observed.head, sources, access };
}

/** S2's bounded raw transport port: pinned maxima, fixed refusals, expected-head CAS. */
export function globalsStorage(github: GitHub): GlobalsStorage {
  return {
    async readFiles(paths, head, maxFileBytes, maxTotalBytes) {
      if (
        paths.length > limits.causes ||
        maxFileBytes > limits.fileBytes ||
        maxTotalBytes > limits.fileBytes
      )
        throw rawReadFailure();
      try {
        return await github.globalBlobs(paths, head, maxFileBytes, maxTotalBytes);
      } catch {
        throw rawReadFailure();
      }
    },
    async commit(head, files, message, user, options) {
      try {
        return await github.commit(head, files, message, user, options);
      } catch (error) {
        if (error instanceof RefRace) throw error;
        // Never auto-retried by clients: the outcome is unknown until an explicit refresh.
        throw new HttpError(503, 'Sync pending: the save could not be confirmed; refresh first');
      }
    },
  };
}

async function context(github: GitHub, user: Identity): Promise<GlobalsContext> {
  const observed = await observeGlobals(github, user);
  return {
    storage: globalsStorage(github),
    head: observed.head,
    sources: observed.sources,
    access: observed.access!,
    user,
    repository: `${github.env.GITHUB_OWNER}/${github.env.GITHUB_REPO}`,
    destinations: globalDestinations(github),
  };
}

function refusal(error: unknown): Response {
  if (error instanceof RefRace)
    return json({ kind: 'conflict', message: 'Source head changed' }, 409);
  if (error instanceof z.ZodError)
    return json({ kind: 'retry', message: 'Sync pending: invalid metadata' }, 503);
  if (!(error instanceof HttpError)) throw error;
  const kind =
    error.status === 403
      ? 'forbidden'
      : error.status === 409
        ? 'conflict'
        : error.status === 503
          ? 'retry'
          : 'invalid';
  return json({ kind, message: error.message }, error.status);
}

/**
 * GET /globals/:id/history?page=N lists commits that touched the entry record;
 * GET /globals/:id/history?commit=<sha> returns that commit's record. A revert is an
 * ordinary body edit through S2, so it meets the same permission, clash, and Sync rules.
 */
async function entryHistory(request: Request, github: GitHub, user: Identity, id: string) {
  if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const ctx = await context(github, user);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== 'page' && key !== 'commit'))
    throw new HttpError(400, 'Invalid history query');
  const path = globalsReleasePaths.entry(id);
  const commit = url.searchParams.get('commit');
  if (commit !== null) {
    if (!oid.safeParse(commit).success) throw new HttpError(400, 'Invalid commit SHA');
    const [file] = await ctx.storage.readFiles(
      [path],
      commit,
      limits.entryBytes,
      limits.entryBytes,
    );
    if (!file) throw new HttpError(404, 'Global entry did not exist at that commit');
    const entry = entrySchema.safeParse(parseRaw(file.bytes));
    if (!entry.success || entry.data.id !== id)
      throw new HttpError(503, 'Sync pending: invalid metadata');
    return json({ kind: 'ok', value: { head: ctx.head, commit, entry: entry.data } });
  }
  const page = Number(url.searchParams.get('page') ?? '1');
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new HttpError(400, 'Invalid page');
  const query = new URLSearchParams({ sha: ctx.head, path, per_page: '30', page: String(page) });
  const commits = historySchema.parse(
    await github.immutable(JSON.stringify(['global-commits', ctx.head, id, page]), () =>
      github.result(`/commits?${query}`),
    ),
  );
  return json({
    kind: 'ok',
    value: {
      head: ctx.head,
      page,
      commits: commits.map((entry) => ({
        commit: entry.sha,
        author: entry.author?.login ?? entry.commit.author?.name ?? null,
        login: entry.author?.login ?? null,
        avatar: entry.author?.avatar_url ?? null,
        date: entry.commit.author?.date ?? null,
        message: entry.commit.message,
      })),
    },
  });
}

/** Authenticated /globals routes; load() observes current permissions/sources EVERY call. */
export async function globalsRoute(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const history = /^\/globals\/(g_[a-zA-Z0-9_-]{8,80})\/history$/.exec(path);
  if (history) {
    try {
      return await entryHistory(request, github, user, history[1]!);
    } catch (error) {
      return refusal(error);
    }
  }
  return globalsHandler(request, () => context(github, user));
}
