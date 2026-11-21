import { z } from 'zod';
import {
  type Aliases,
  aliasGroupsPath,
  languages,
  carryNumberTranslations,
  hashSchema,
  merge3,
  permissionsSchema,
  reconcileNumberMap,
  refreshNumberFallbacks,
  resolveAlias,
  sandboxPointersPath,
  stableStringify,
  tooltipSchema,
  type Tooltip,
} from '@clarity/core';
import { loadAliases } from './catalog.js';
import { exporter, needsLowering, publisherPinPath, refuseUnlowerable } from './elementTags.js';
import { RefRace, type GitHub } from './github.js';
import { consumerAliasScope, withSandboxPointers } from './sandboxPointers.js';
import { body, HttpError, json } from './http.js';
import {
  checkEdit,
  checkEnglishRevision,
  checkTranslationStamps,
  requireAccess,
  type Access,
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
  const result = await saveChanges(github, user, await body(request, saveSchema));
  return 'conflicts' in result ? json(result, 409) : json(result);
}

export type SaveInput = z.infer<typeof saveSchema>;
export type SaveResult =
  | { commit: string; tooltips: Tooltip[]; savedAt: number }
  | {
      conflicts: {
        hash: number;
        base: Tooltip | null;
        head: Tooltip | null;
        next: Tooltip;
        fields: string[];
      }[];
    };

const compendiumContent = (link: Tooltip['compendium']) =>
  link ? { ...link, snapshotAt: undefined } : undefined;

function createdContent(tooltip: Tooltip): string {
  const { text, bungieSnapshot, compendium, ...fields } = tooltip;
  return stableStringify({
    ...fields,
    compendium: compendiumContent(compendium),
    bungieDescription: bungieSnapshot?.description,
    text: Object.fromEntries(Object.entries(text).map(([lang, entry]) => [lang, entry.text])),
  });
}

/**
 * The /save pipeline (merge, every write check, server-owned maps, CAS commit authored by `user`).
 * `authorize` adds a caller's own rule against the access read at each attempt's head (rollback).
 */
export async function saveChanges(
  github: GitHub,
  user: Identity,
  input: SaveInput,
  authorize?: (access: Access) => void,
): Promise<SaveResult> {
  let aliases: Aliases | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await github.publishSnapshot(['config/permissions.json']);
    const headCommit = snapshot.head;
    const permissionFile = snapshot.files[0];
    if (!permissionFile)
      throw new HttpError(502, 'Missing repository file: config/permissions.json');
    const access = requireAccess(permissionsSchema.parse(permissionFile.value), user, [
      'maintainer',
      'editor',
      'trial',
      'translator',
    ]);
    authorize?.(access);
    const conflicts: {
      hash: number;
      base: Tooltip | null;
      head: Tooltip | null;
      next: Tooltip;
      fields: string[];
    }[] = [];
    const tooltips: Tooltip[] = [];
    const writes: Record<string, Tooltip> = {};
    const changed: string[] = [];
    const carried: string[] = [];
    const kept: number[] = [];
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
        aliasGroupsPath,
      ],
      headCommit,
    );
    const generatorAliases = current.at(-1)
      ? {}
      : (aliases ??= await loadAliases(github.env, github));
    // A picked shared sandbox perk is an alias of its target, exactly as push and publish see it.
    const scope = current.at(-1)
      ? await consumerAliasScope(
          github,
          current.at(-1),
          current.at(-2),
          input.changes.map(({ hash }) => hash),
        )
      : undefined;
    const saveAliases =
      scope?.aliases ?? (await withSandboxPointers(github, generatorAliases, current.at(-2)));
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
      // Maps are server-owned. Preserve the submitted base's map for the merge, so a stale
      // client map cannot turn an otherwise untouched English entry into a competing edit.
      const next = structuredClone(change.next);
      if (next.text.en) {
        delete next.text.en.numbers;
        if (change.base?.text.en?.numbers) next.text.en.numbers = change.base.text.en.numbers;
      }
      let merged = next;
      let rebased = false;
      if (head && change.base) {
        // Both inputs were already validated. Byte equality also avoids hashing and
        // reparsing the same tooltip twice solely to decide whether a merge is needed.
        rebased = stableStringify(head) !== stableStringify(change.base);
        if (
          rebased &&
          next.compendium &&
          head.compendium &&
          head.compendium.snapshotAt !== change.base.compendium?.snapshotAt &&
          stableStringify(compendiumContent(head.compendium)) ===
            stableStringify(compendiumContent(next.compendium))
        )
          next.compendium = head.compendium;
        const result = rebased
          ? merge3(change.base, head, next)
          : { ok: true as const, merged: next };
        if (!result.ok) {
          conflicts.push({ ...change, head, fields: result.conflicts.map(({ field }) => field) });
          continue;
        }
        merged = result.merged;
      } else if (head && createdContent(head) === createdContent(next)) {
        // A new tooltip may have landed even when the browser never received its response.
        tooltips.push(head);
        continue;
      } else if (head || change.base) {
        conflicts.push({ ...change, head, fields: ['$exists'] });
        continue;
      }
      if (rebased) checkEdit(access, head, merged);
      // Against the real head, after the merge: what this commit does to the English revision.
      if (checkEnglishRevision(access, head, merged, input.noTranslationImpact === true) === 'kept')
        kept.push(merged.hash);
      const english = merged.text.en;
      if (english) {
        const numbers =
          head?.text.en?.text === english.text
            ? structuredClone(head.text.en.numbers)
            : reconcileNumberMap(head?.text.en, english, merged);
        delete english.numbers;
        if (numbers) english.numbers = numbers;
      }
      // Authorization above covers the submitted edits, before server-owned map changes.
      for (const lang of languages)
        if (lang !== 'en' && merged.text[lang]?.text !== head?.text[lang]?.text)
          refreshNumberFallbacks(merged, lang);
      checkTranslationStamps(head, merged);
      refuseUnlowerable(merged, await exporterPin(merged), 'saved', head);
      if (
        head &&
        head.text.en?.text !== merged.text.en?.text &&
        Object.keys(merged.text).some((lang) => lang !== 'en')
      ) {
        const result = carryNumberTranslations(head, merged);
        merged = result.tooltip;
        if (result.carried.length) carried.push(`${merged.hash}=${result.carried.join(',')}`);
      }
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
      if (rebased && !fields.length && head && stableStringify(head) === stableStringify(merged))
        continue;
      writes[`tooltips/${merged.hash}.json`] = merged;
      changed.push(`${merged.hash}=${fields.join(',') || 'none'}`);
    }
    if (conflicts.length) return { conflicts };
    if (!changed.length) return { commit: headCommit, tooltips, savedAt: Date.now() };
    try {
      const commit = await github.commit(
        headCommit,
        writes,
        // Carried languages are attributed per tooltip, immediately after Clarity-Changed.
        `${input.message}\n\n${kept.length ? `Clarity-No-Translation-Impact: ${kept.join(',')}\n` : ''}Clarity-Changed: ${changed.join(';')}${carried.length ? `\nClarity-Carried: ${carried.join(';')}` : ''}`,
        user,
        { baseTree: snapshot.tree },
      );
      // Explicit body time is readable cross-origin without exposing response headers.
      return { commit, tooltips, savedAt: Date.now() };
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry your save');
}
