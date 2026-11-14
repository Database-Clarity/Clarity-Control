import { z } from 'zod';
import {
  hashSchema,
  isMovedInactive,
  inactiveMovesCapability,
  inactiveMovesPath,
  inactiveMovesSchema,
  permissionsSchema,
  type InactiveMoves,
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
    hash: hashSchema,
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
