import { z } from 'zod';
import {
  type Aliases,
  contentHash,
  hashSchema,
  merge3,
  resolveAlias,
  tooltipSchema,
  type Tooltip,
} from '@clarity/core';
import { loadAliases } from './catalog.js';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { checkEdit, permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

const changeSchema = z
  .object({
    hash: hashSchema,
    base: tooltipSchema.nullable(),
    next: tooltipSchema,
  })
  .strict()
  .refine(({ hash, base, next }) => next.hash === hash && (!base || base.hash === hash), {
    message: 'Change hash, base hash and next hash must agree',
  });
const saveSchema = z
  .object({
    changes: z
      .array(changeSchema)
      .min(1)
      .max(100)
      .refine(
        (changes) => new Set(changes.map(({ hash }) => hash)).size === changes.length,
        'Duplicate tooltip hash',
      ),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

export async function save(request: Request, github: GitHub, user: Identity): Promise<Response> {
  const input = await body(request, saveSchema);
  let aliases: Aliases | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const headCommit = await github.head();
    const access = requireAccess(await permissions(github, headCommit), user, [
      'maintainer',
      'editor',
      'trial',
      'translator',
    ]);
    const conflicts: {
      hash: number;
      base: Tooltip | null;
      head: Tooltip | null;
      next: Tooltip;
      fields: string[];
    }[] = [];
    const tooltips: Tooltip[] = [];
    aliases ??= await loadAliases(github.env, github);
    // One batched read for all current copies: flat subrequests however many tooltips change.
    const current = await github.files(
      input.changes.map(({ hash }) => `tooltips/${hash}.json`),
      headCommit,
    );
    for (const [index, change] of input.changes.entries()) {
      const canonical = resolveAlias(change.hash, aliases);
      if (canonical !== change.hash) {
        throw new HttpError(
          422,
          `Tooltip ${change.hash} is an alias; edit canonical tooltip ${canonical}`,
        );
      }
      checkEdit(access, change.base, change.next);
      const file = current[index];
      const head = file ? tooltipSchema.parse(file.value) : null;
      if (head && head.hash !== change.hash)
        throw new HttpError(502, 'Stored tooltip hash mismatch');
      let merged = change.next;
      if (head && change.base) {
        const result =
          (await contentHash(head)) === (await contentHash(change.base))
            ? { ok: true as const, merged: change.next }
            : merge3(change.base, head, change.next);
        if (!result.ok) {
          conflicts.push({ ...change, head, fields: result.conflicts.map(({ field }) => field) });
          continue;
        }
        merged = result.merged;
      } else if (head || change.base) {
        conflicts.push({ ...change, head, fields: ['$exists'] });
        continue;
      }
      checkEdit(access, head, merged);
      tooltips.push(merged);
    }
    if (conflicts.length) return json({ conflicts }, 409);
    try {
      const commit = await github.commit(
        headCommit,
        Object.fromEntries(tooltips.map((tooltip) => [`tooltips/${tooltip.hash}.json`, tooltip])),
        input.message,
        user,
      );
      return json({ commit, tooltips });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry your save');
}
