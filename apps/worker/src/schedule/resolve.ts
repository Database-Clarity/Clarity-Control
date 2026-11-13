import { z } from 'zod';
import { contentHash, hashSchema, languages, tooltipSchema, type Tooltip } from '@clarity/core';
import {
  activationConflictSchema,
  existsField,
  resolveActivation,
  schedulePaths,
  type ResolutionResult,
} from '@clarity/core/schedule';
import { pinLowersElementTags, refuseUnlowerableTags } from '../elementTags.js';
import { RefRace, type GitHub } from '../github.js';
import { body, HttpError, json } from '../http.js';
import { checkEdit } from '../permissions.js';
import type { Identity } from '../types.js';
import {
  appendEvent,
  archivedCounter,
  by,
  checkedBatch,
  indexEntry,
  readState,
  requireBatch,
  scheduleRoles,
  switches,
  withIndexEntry,
} from './store.js';

const resolveSchema = z
  .object({
    hash: hashSchema,
    /** contentHash of the current tooltip the user resolved against; null = it was absent. */
    expectedCurrent: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    choices: z.record(z.string().min(1).max(64), z.enum(['upcoming', 'current'])),
  })
  .strict();

/** History trailer fields, as /save writes them (apps/web features/history/scope.ts). */
function historyFields(before: Tooltip | null, after: Tooltip): string {
  const fields = [
    ...languages.filter(
      (language) => JSON.stringify(before?.text[language]) !== JSON.stringify(after.text[language]),
    ),
    ...(['associated', 'custom', 'archive', 'compendium'] as const)
      .filter(
        (field) =>
          JSON.stringify(before?.[field] ?? (field === 'associated' ? [] : null)) !==
          JSON.stringify(after[field] ?? (field === 'associated' ? [] : null)),
      )
      .map((field) => (field === 'associated' ? 'associations' : field)),
  ];
  return fields.join(',') || 'none';
}

/**
 * POST /batches/:id/resolve {hash, expectedCurrent, choices} (spec "Activation and conflicts",
 * R4, R12): re-merges against current at this head; ONE CAS commit writes the tooltip, deletes
 * the conflict file, and appends an event. A moved current or a field without a choice is 409.
 */
export async function resolveBatch(
  request: Request,
  github: GitHub,
  user: Identity,
  batchId: string,
): Promise<Response> {
  const input = await body(request, resolveSchema, 64 * 1024);
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(github, user, scheduleRoles, {
      batchId,
      extra: [schedulePaths.conflict(input.hash), `tooltips/${input.hash}.json`],
      trees: [
        { path: `schedule/batches/${batchId}/events`, depth: 1 },
        { path: `schedule/batches/${batchId}/tooltips`, depth: 1 },
      ],
    });
    const batch = requireBatch(state, batchId);
    const [conflictRaw, currentRaw] = state.extra;
    if (!conflictRaw)
      throw new HttpError(404, `Tooltip ${input.hash} has no activation conflict to resolve`);
    const conflict = activationConflictSchema.parse(conflictRaw.value);
    if (conflict.hash !== input.hash) throw new HttpError(502, 'Stored conflict hash mismatch');
    if (conflict.batchId !== batchId)
      throw new HttpError(409, 'This conflict belongs to another batch', {
        batchId: conflict.batchId,
      });
    if (batch.status !== 'published') throw new HttpError(502, 'Conflict on an unpublished batch');
    const current = currentRaw ? tooltipSchema.parse(currentRaw.value) : null;
    if (current && current.hash !== input.hash)
      throw new HttpError(502, 'Stored tooltip hash mismatch');
    const currentHash = current ? await contentHash(current) : null;
    if (currentHash !== input.expectedCurrent)
      return json({ error: 'Current changed; review the conflict again', current }, 409);
    let result: ResolutionResult;
    const resolution = {
      base: conflict.base,
      current,
      proposed: conflict.proposed,
    };
    try {
      result = resolveActivation({ ...resolution, choices: input.choices });
    } catch (error) {
      // An existence choice where none applies (the tooltip exists, or the batch created it):
      // report what DOES need a choice now, per field (P1 OPEN for P2).
      if (existsField in input.choices) {
        const rest = Object.fromEntries(
          Object.entries(input.choices).filter(([field]) => field !== existsField),
        );
        let missing: string[] = [];
        try {
          const retry = resolveActivation({ ...resolution, choices: rest });
          missing = retry.ok ? [] : retry.missing;
        } catch {
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid choices');
        }
        return json(
          { error: 'The existence choice no longer applies; choose per field', missing, current },
          409,
        );
      }
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid choices');
    }
    if (!result.ok)
      return json(
        {
          error: 'Choose upcoming or current for every conflicted field',
          missing: result.missing,
          current,
        },
        409,
      );
    const tooltip = result.tooltip;
    if (tooltip) {
      checkEdit(state.access, current, tooltip);
      refuseUnlowerableTags(
        tooltip,
        !switches.publisher() || pinLowersElementTags(state.pin),
        'saved',
      );
    }
    const at = new Date().toISOString();
    const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
    const appended = await appendEvent(
      batch,
      { at, by: by(user), action: 'resolve', ...revisions, hashes: [input.hash] },
      archivedCounter(github, state.head, batchId, state.trees[0]),
    );
    const next = checkedBatch({ ...batch, ...revisions, events: appended.events });
    const hashes = (state.trees[1] ?? [])
      .map(({ name }) => /^(0|[1-9]\d*)\.json$/.exec(name)?.[1])
      .filter((hash): hash is string => hash !== undefined)
      .map(Number);
    const files: Record<string, unknown> = {
      [schedulePaths.batch(batchId)]: next,
      [schedulePaths.index]: withIndexEntry(state.index, indexEntry(next, hashes, at)),
      ...(appended.archive ? { [appended.archive.path]: appended.archive.value } : {}),
    };
    if (tooltip) files[`tooltips/${input.hash}.json`] = tooltip;
    const trailer = tooltip
      ? `\nClarity-Changed: ${input.hash}=${historyFields(current, tooltip)}`
      : '';
    try {
      const commit = await github.commit(
        state.head,
        files,
        `Resolve batch activation of ${input.hash} ("${batch.name}")\n\nClarity-Batch: ${batchId}${trailer}`,
        user,
        { baseTree: state.tree, deletions: [schedulePaths.conflict(input.hash)] },
      );
      return json({ commit, tooltip, batch: next });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; retry');
}
