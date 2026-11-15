import { z } from 'zod';
import {
  type Aliases,
  languages,
  contentHash,
  hashSchema,
  merge3,
  resolveAlias,
  sandboxPointersPath,
  tooltipSchema,
  type Tooltip,
} from '@clarity/core';
import { loadAliases } from './catalog.js';
import {
  exporter,
  needsLowering,
  publisherPinPath,
  refuseUnlowerable,
} from './elementTags.js';
import { RefRace, type GitHub } from './github.js';
import { withSandboxPointers } from './sandboxPointers.js';
import { body, HttpError, json } from './http.js';
import {
  checkEdit,
  checkEnglishRevision,
  checkTranslationStamps,
  permissions,
  requireAccess,
} from './permissions.js';
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
    // "No translation impact" (TR3): English wording changes keep their English revision.
    // Sent only when ticked; ignored for saves without such a change (checkEnglishRevision).
    noTranslationImpact: z.boolean().optional(),
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
    const changed: string[] = [];
    const kept: number[] = [];
    const generatorAliases = (aliases ??= await loadAliases(github.env, github));
    // One batched read for all current copies: flat subrequests however many tooltips change.
    // While the publisher is the live exporter, a change carrying element-tagged text, `#{name}`,
    // or `<enhanced/>` also reads the publisher's PIN in the same call: only a build declaring
    // the matching capability lowers them.
    const publisher = exporter.publisherEnabled();
    const readsPin = publisher && input.changes.some(({ next }) => needsLowering(next));
    const current = await github.files(
      [
        ...input.changes.map(({ hash }) => `tooltips/${hash}.json`),
        ...(readsPin ? [publisherPinPath] : []),
        sandboxPointersPath,
      ],
      headCommit,
    );
    // A picked shared sandbox perk is an alias of its target, exactly as push and publish see it.
    const saveAliases = await withSandboxPointers(github, generatorAliases, current.at(-1));
    let pin: { value: unknown } | undefined = readsPin
      ? { value: current[input.changes.length]?.value }
      : undefined;
    // The PIN the active exporter's capabilities come from; undefined while push-live exports
    // (it always lowers) or when there is nothing to lower.
    const exporterPin = async (tooltip: Tooltip) => {
      if (!publisher || !needsLowering(tooltip)) return undefined;
      // A form only the merge brought in (another save at the head): read the PIN now.
      pin ??= { value: (await github.files([publisherPinPath], headCommit))[0]?.value };
      return pin;
    };
    for (const [index, change] of input.changes.entries()) {
      const canonical = resolveAlias(change.hash, saveAliases);
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
      // Against the real head, after the merge: what this commit does to the English revision.
      if (checkEnglishRevision(access, head, merged, input.noTranslationImpact === true) === 'kept')
        kept.push(merged.hash);
      checkTranslationStamps(head, merged);
      refuseUnlowerable(merged, await exporterPin(merged), 'saved');
      tooltips.push(merged);
      // Per-tooltip hints avoid attributing another item in a batch to this file.
      // Display only: permissions and the committed payload are unchanged.
      const fields = [
        ...languages.filter(
          (language) =>
            JSON.stringify(head?.text[language]) !== JSON.stringify(merged.text[language]),
        ),
        ...(['associated', 'custom', 'archive', 'compendium'] as const)
          .filter(
            (field) =>
              JSON.stringify(head?.[field] ?? (field === 'associated' ? [] : null)) !==
              JSON.stringify(merged[field] ?? (field === 'associated' ? [] : null)),
          )
          .map((field) => (field === 'associated' ? 'associations' : field)),
      ];
      changed.push(`${merged.hash}=${fields.join(',') || 'none'}`);
    }
    if (conflicts.length) return json({ conflicts }, 409);
    try {
      const commit = await github.commit(
        headCommit,
        Object.fromEntries(tooltips.map((tooltip) => [`tooltips/${tooltip.hash}.json`, tooltip])),
        // Clarity-Changed stays the final line (History reads it there). The audit line lists the
        // tooltips whose English change kept its revision: translations were not marked outdated.
        `${input.message}\n\n${kept.length ? `Clarity-No-Translation-Impact: ${kept.join(',')}\n` : ''}Clarity-Changed: ${changed.join(';')}`,
        user,
      );
      // Explicit body time is readable cross-origin without exposing response headers.
      return json({ commit, tooltips, savedAt: Date.now() });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry your save');
}
