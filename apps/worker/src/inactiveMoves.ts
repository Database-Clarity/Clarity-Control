import { z } from 'zod';
import {
  clearedRemovalsCapability,
  clearedState,
  hashSchema,
  inactiveRemovalHash,
  isMovedInactive,
  inactiveMovesCapability,
  inactiveMovesPath,
  inactiveMovesSchema,
  permissionsSchema,
  pushedSchema,
  tooltipSchema,
  withoutEnglish,
  type InactiveMoves,
  type Tooltip,
} from '@clarity/core';
import { blobContent, blobSha, RefRace, type GitHub, type RepoFile } from './github.js';
import { body, HttpError, json } from './http.js';
import { requireAccess } from './permissions.js';
import type { Identity } from './types.js';
import { exporter, publisherPinPath } from './elementTags.js';

const updateSchema = z
  .object({
    revision: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    hash: hashSchema.refine((hash) => hash < 1 || hash > 3, 'Global definitions cannot be moved'),
    inactive: z.boolean(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export function storedInactiveMoves(file: RepoFile | null | undefined): InactiveMoves {
  if (!file) return {};
  const parsed = inactiveMovesSchema.safeParse(file.value);
  if (!parsed.success) throw new HttpError(502, `Invalid ${inactiveMovesPath} in editor data`);
  return parsed.data;
}

export function pinAppliesInactiveMoves(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(inactiveMovesCapability);
}

/** Whether the installed publisher removes a published tooltip whose English was cleared. */
export function pinRemovesCleared(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(clearedRemovalsCapability);
}

/**
 * Each document's cleared state at `head` (core clearedState), for the ones that have one. One
 * read of the published markers and versions, and only when a document has no English.
 */
export async function clearedStates(
  github: GitHub,
  head: string,
  documents: readonly Tooltip[],
  moves: InactiveMoves,
) {
  const states = new Map<number, 'removal' | 'removed'>();
  const candidates = documents.filter(
    (document) => withoutEnglish(document) && !isMovedInactive(document.hash, moves),
  );
  if (!candidates.length) return states;
  const [markers, ...versions] = await github.files(
    ['live/pushed.json', ...candidates.map(({ hash }) => `live/tooltips/${hash}.json`)],
    head,
  );
  // Only these markers: the whole schema over every published row costs request CPU.
  const all = (markers?.value ?? {}) as Record<string, unknown>;
  const pushed = pushedSchema.parse(
    Object.fromEntries(
      candidates.flatMap(({ hash }) => (Object.hasOwn(all, hash) ? [[hash, all[hash]]] : [])),
    ),
  );
  for (const [index, document] of candidates.entries()) {
    const published = versions[index];
    const state = clearedState(
      document,
      pushed[document.hash],
      await inactiveRemovalHash(document.hash),
      !!published && !withoutEnglish(tooltipSchema.parse(published.value)),
    );
    if (state) states.set(document.hash, state);
  }
  return states;
}

/** One-item mutation, whole-file CAS, and permissions rechecked on every ref-race retry. */
export async function inactiveMovesRoute(request: Request, github: GitHub, user: Identity) {
  let input: z.infer<typeof updateSchema> | null = null;
  let invalid: unknown;
  if (request.method === 'PUT')
    input = await body(request, updateSchema, 4096).catch((error: unknown) => {
      invalid = error;
      return null;
    });
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const [permissions, file, pin] = await github.files(
      [
        'config/permissions.json',
        inactiveMovesPath,
        ...(exporter.publisherEnabled() ? [publisherPinPath] : []),
      ],
      head,
    );
    if (!permissions) throw new HttpError(502, 'Required repository file is missing');
    requireAccess(permissionsSchema.parse(permissions.value), user, ['maintainer']);
    if (invalid) throw invalid;
    const moves = storedInactiveMoves(file);
    const revision = file?.sha ?? null;
    if (!input) return json({ revision, moves });
    if (input.revision !== revision)
      throw new HttpError(409, 'Inactive moves changed since they were loaded; reload and retry');
    // Older signed/queued requests must not run on a runtime that would ignore a newly saved move.
    if (exporter.publisherEnabled() && !pinAppliesInactiveMoves(pin?.value))
      throw new HttpError(
        409,
        'The installed publisher lacks the "inactiveMoves" capability; update it before saving moves',
      );
    const next = { ...moves };
    if (input.inactive) {
      // Repeated move-in is idempotent and preserves attribution.
      if (!isMovedInactive(input.hash, moves))
        next[input.hash] = {
          by: user.id,
          at: new Date().toISOString(),
          ...(input.note ? { note: input.note } : {}),
        };
    } else if (isMovedInactive(input.hash, moves))
      next[input.hash] = {
        inactive: false,
        by: user.id,
        at: new Date().toISOString(),
        ...(input.note ? { note: input.note } : {}),
      };
    try {
      const commit = await github.commit(
        head,
        { [inactiveMovesPath]: next },
        `Move ${input.hash} ${input.inactive ? 'to' : 'out of'} Inactive by ${user.login}`,
        user,
      );
      return json({ commit, revision: await blobSha(blobContent(next)), moves: next });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload inactive moves and retry');
}
