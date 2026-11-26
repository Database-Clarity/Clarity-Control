import { z } from 'zod';
import {
  type Aliases,
  aliasGroupsPath,
  languages,
  carryNumberTranslations,
  clearsEnglish,
  hashSchema,
  globalsInPlacePath,
  hasSandboxTargets,
  isTranslatable,
  merge3,
  mergeSandboxPointers,
  permissionsSchema,
  reconcileNumberMap,
  refreshNumberFallbacks,
  resolveAlias,
  sandboxPointersPath,
  stableStringify,
  tooltipSchema,
  translationStateOf,
  type Lang,
  type Tooltip,
} from '@clarity/core';
import { translationRevisionsSchema } from '../../../packages/core/src/translationRevision.js';
import { loadAliases } from './catalog.js';
import { exporter, needsLowering, publisherPinPath, refuseUnlowerable } from './elementTags.js';
import { RefRace, SaveTiming, type GitHub } from './github.js';
import {
  consumerAliasScope,
  loadSandboxConflicts,
  storedSandboxPointers,
  withSandboxPointers,
} from './sandboxPointers.js';
import { body, HttpError, json } from './http.js';
import {
  clearedSaveMessage,
  checkEdit,
  checkEnglishRevision,
  checkTranslationStamps,
  requireAccess,
  type Access,
} from './permissions.js';
import type { Identity } from './types.js';
import { refuseInPlaceSave } from './globals/inPlace.js';
import { clearedStates } from './inactiveMoves.js';

export const currentSaveRoles: Access['role'][] = ['maintainer', 'editor', 'trial', 'translator'];

const changeSchema = z
  .object({
    hash: hashSchema,
    base: tooltipSchema.nullable(),
    next: tooltipSchema,
    translationRevisions: translationRevisionsSchema.optional(),
  })
  .strict()
  .refine(({ hash, base, next }) => next.hash === hash && (!base || base.hash === hash), {
    message: 'Change hash, base hash and next hash must agree',
  });
export const savedChangesSchema = z
  .object({
    changes: z
      .array(changeSchema)
      .min(1)
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
const saveSchema = savedChangesSchema.extend({
  changes: savedChangesSchema.shape.changes.max(100),
});

export async function save(request: Request, github: GitHub, user: Identity): Promise<Response> {
  const timing = new SaveTiming();
  github.saveTiming = timing;
  const done = timing.start('total');
  let response: Response | undefined;
  try {
    const result = await saveChanges(github, user, await body(request, saveSchema));
    response = 'conflicts' in result ? json(result, 409) : json(result);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(
      { error: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
      error.status,
    );
  } finally {
    done();
    const header = timing.header();
    response?.headers.set('Server-Timing', header);
    console.info('POST /save timing', header);
  }
  return response;
}

async function timed<T>(github: GitHub, name: string, run: () => Promise<T>): Promise<T> {
  const stop = github.saveTiming?.start(name);
  try {
    return await run();
  } finally {
    stop?.();
  }
}

export type SaveInput = z.infer<typeof savedChangesSchema>;
export type SaveResult =
  | { commit: string; tooltips: Tooltip[]; savedAt: number }
  | {
      conflicts: {
        hash: number;
        base: Tooltip | null;
        head: Tooltip | null;
        next: Tooltip;
        fields: string[];
        translationRevisions?: SaveInput['changes'][number]['translationRevisions'];
        headCommit?: string;
      }[];
    };
type SaveConflicts = Extract<SaveResult, { conflicts: unknown }>;
type SavePlan =
  SaveConflicts | { writes: Record<string, Tooltip>; tooltips: Tooltip[]; message: string };

const saveMetadata = ['config/permissions.json', globalsInPlacePath];
const parsedPermissions = new WeakMap<
  GitHub['env'],
  { sha: string; value: z.infer<typeof permissionsSchema> }
>();

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
  const proofFiles = new Map<string, Tooltip | null>();
  const verifiedCommits = new Set<string>();
  let verifiedHead: string | undefined;
  const clears = input.changes.filter(({ base, next }) => clearsEnglish(base, next));
  const hashes = input.changes.map(({ hash }) => hash);
  const publisher = exporter.publisherEnabled();
  // Carry the active exporter's PIN with the current copies whenever submitted markup needs it.
  const readsPin = publisher && input.changes.some(({ next }) => needsLowering(next));
  const paths = [
    ...hashes.map((hash) => `tooltips/${hash}.json`),
    ...(readsPin ? [publisherPinPath] : []),
    sandboxPointersPath,
    aliasGroupsPath,
  ];
  let combine =
    !!github.saveTiming &&
    hashes.length <= 50 &&
    !clears.length &&
    !input.changes.some(
      ({ hash, translationRevisions }) =>
        (hash >= 1 && hash <= 3) || translationRevisions !== undefined,
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const combined = combine
      ? await timed(github, 'head_files', () => github.saveSnapshot(saveMetadata, paths))
      : undefined;
    if (!combined) combine = false;
    const snapshot =
      combined ?? (await timed(github, 'head', () => github.publishSnapshot(saveMetadata)));
    const headCommit = snapshot.head;
    const permissionFile = snapshot.files[0];
    if (!permissionFile)
      throw new HttpError(502, 'Missing repository file: config/permissions.json');
    let permissions = parsedPermissions.get(github.env);
    if (permissions?.sha !== permissionFile.sha) {
      permissions = {
        sha: permissionFile.sha,
        value: permissionsSchema.parse(permissionFile.value),
      };
      parsedPermissions.set(github.env, permissions);
    }
    const access = requireAccess(permissions.value, user, currentSaveRoles);
    authorize?.(access);
    const current =
      combined?.read() ?? (await timed(github, 'files', () => github.files(paths, headCommit)));
    const saveAliases = await timed(github, 'generator', async () => {
      // A picked shared sandbox perk is an alias of its target, exactly as push and publish see it.
      const groups = current.at(-1);
      const pointersFile = current.at(-2);
      if (groups)
        return (await consumerAliasScope(github, groups, pointersFile, hashes, false, {
          cachePinnedInputs: combine,
        }))!.aliases;
      if (combine && !aliases && pointersFile && github.remaining >= 2) {
        const [generated, sandbox] = await Promise.allSettled([
          loadAliases(github.env, github),
          (async () => {
            const pointers = storedSandboxPointers(pointersFile);
            const conflicts = hasSandboxTargets(pointers)
              ? await loadSandboxConflicts(github.env, github)
              : {};
            return { pointers, conflicts };
          })(),
        ]);
        if (generated.status === 'rejected') throw generated.reason;
        if (sandbox.status === 'rejected') throw sandbox.reason;
        aliases = generated.value;
        return mergeSandboxPointers(aliases, sandbox.value.conflicts, sandbox.value.pointers);
      }
      aliases ??= await loadAliases(github.env, github);
      return withSandboxPointers(github, aliases, pointersFile);
    });
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
    const isAncestor = async (commit: string) => {
      if (commit === headCommit) return true;
      const response = await github.request(`/compare/${headCommit}...${commit}?per_page=1`);
      if (response.status === 404 || response.status === 422) return false;
      if (!response.ok) throw new HttpError(502, 'Cannot check translation revision history');
      const { status } = z.object({ status: z.string() }).parse(await response.json());
      return status === 'behind' || status === 'identical';
    };
    const readRevision = async (commit: string, hash: number): Promise<Tooltip | null> => {
      if (verifiedHead !== headCommit) {
        if (verifiedHead && !(await isAncestor(verifiedHead))) verifiedCommits.clear();
        verifiedHead = headCommit;
      }
      if (!verifiedCommits.has(commit)) {
        if (!(await isAncestor(commit))) return null;
        verifiedCommits.add(commit);
      }
      const key = `${commit}:${hash}`;
      if (commit === headCommit) {
        const file = current[input.changes.findIndex((change) => change.hash === hash)];
        return file ? tooltipSchema.parse(file.value) : null;
      }
      if (!proofFiles.has(key)) {
        const missing = input.changes.flatMap((change) =>
          [
            ...new Set(
              Object.values(change.translationRevisions ?? {}).map((proof) => proof.commit),
            ),
          ]
            .filter((ref) => ref !== headCommit && !proofFiles.has(`${ref}:${change.hash}`))
            .map((ref) => ({
              ref,
              path: `tooltips/${change.hash}.json`,
              key: `${ref}:${change.hash}`,
            })),
        );
        const files = await github.blobs(missing);
        for (const [index, { key }] of missing.entries()) {
          const file = files[index];
          proofFiles.set(key, file ? tooltipSchema.parse(file.value) : null);
        }
      }
      return proofFiles.get(key) ?? null;
    };
    const plan = await timed(github, 'validation', async () => {
      const plan = await planSaveChanges(
        input,
        access,
        current,
        saveAliases,
        exporterPin,
        Date.now(),
        {
          login: user.login,
          headCommit,
          read: readRevision,
        },
      );
      if ('conflicts' in plan) return plan;
      const cleared = await clearedStates(
        github,
        headCommit,
        clears.map(({ next }) => next),
        {},
      );
      for (const { hash } of clears)
        if (cleared.get(hash)?.state !== 'removal')
          throw new HttpError(422, clearedSaveMessage(hash));
      if (snapshot.files[1]) for (const tooltip of plan.tooltips) refuseInPlaceSave(tooltip);
      return plan;
    });
    if ('conflicts' in plan) return plan;
    if (!Object.keys(plan.writes).length)
      return { commit: headCommit, tooltips: plan.tooltips, savedAt: Date.now() };
    try {
      const commit = await github.commit(headCommit, plan.writes, plan.message, user, {
        baseTree: snapshot.tree,
      });
      // Explicit body time is readable cross-origin without exposing response headers.
      return { commit, tooltips: plan.tooltips, savedAt: Date.now() };
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry your save');
}

interface RevisionHistory {
  login: string;
  headCommit: string;
  read(commit: string, hash: number): Promise<Tooltip | null> | Tooltip | null;
}

/** Stamp-only requests must name a real revision of this exact translation in data history. */
async function verifyTranslationRevisions(
  change: SaveInput['changes'][number],
  head: Tooltip | null,
  merged: Tooltip,
  access: Access,
  now: number,
  history: RevisionHistory | undefined,
) {
  const verified: Lang[] = [];
  const marked: Lang[] = [];
  const restored: Lang[] = [];
  const revisions = change.translationRevisions;
  if (!revisions) return { verified, marked, restored };
  const invalid = (lang: Lang) =>
    new HttpError(422, `Tooltip ${change.hash}: invalid ${lang} translation revision`);
  const snapshots = new Map<string, Tooltip | null>();
  for (const lang of languages) {
    if (lang === 'en') continue;
    const proof = revisions[lang];
    if (!proof) continue;
    if (access.role === 'translator' && !access.languages?.includes(lang))
      throw new HttpError(403, 'Translators may confirm only their assigned languages');
    const before = head?.text[lang];
    const submitted = change.base?.text[lang];
    const after = merged.text[lang];
    if (
      !history ||
      !before ||
      !head?.text.en ||
      !submitted ||
      !after ||
      !merged.text.en ||
      after.updatedBy !== history.login ||
      Date.parse(after.updatedAt) > now + 5 * 60_000 ||
      after.sourceUpdatedAt !== proof.sourceUpdatedAt ||
      Date.parse(proof.sourceUpdatedAt) > Date.parse(merged.text.en!.updatedAt) ||
      Date.parse(proof.sourceUpdatedAt) > Date.parse(head.text.en.updatedAt) ||
      stableStringify({
        ...after,
        updatedAt: before.updatedAt,
        updatedBy: before.updatedBy,
        sourceUpdatedAt: before.sourceUpdatedAt,
      }) !== stableStringify(before) ||
      submitted.text !== after.text
    )
      throw invalid(lang);
    if (!snapshots.has(proof.commit))
      snapshots.set(proof.commit, await history.read(proof.commit, change.hash));
    const reviewed = snapshots.get(proof.commit);
    if (
      !reviewed ||
      reviewed.hash !== change.hash ||
      !reviewed.text.en ||
      reviewed.text[lang]?.text !== after.text
    )
      throw invalid(lang);
    const reviewedEnglish = reviewed.text.en!.updatedAt;
    if (proof.restore) {
      if ((reviewed.text[lang]?.sourceUpdatedAt ?? reviewedEnglish) !== proof.sourceUpdatedAt)
        throw invalid(lang);
      if (
        Date.parse(before.sourceUpdatedAt ?? head.text.en.updatedAt) ===
        Date.parse(proof.sourceUpdatedAt)
      ) {
        merged.text[lang] = before;
        continue;
      }
      restored.push(lang);
    } else {
      const state = translationStateOf(reviewed, lang);
      if (
        !isTranslatable(reviewed) ||
        reviewedEnglish !== proof.sourceUpdatedAt ||
        state.state !== 'outdated' ||
        state.reason === 'numbers'
      )
        throw invalid(lang);
      if (!isTranslatable(merged) || translationStateOf(merged, lang).reason === 'numbers') {
        merged.text[lang] = before;
        verified.push(lang);
        continue;
      }
      // A later confirmation (or a retry of this one) already covers what was reviewed.
      if (Date.parse(before.sourceUpdatedAt ?? '') >= Date.parse(proof.sourceUpdatedAt)) {
        merged.text[lang] = before;
        continue;
      }
      marked.push(lang);
    }
    verified.push(lang);
  }
  return { verified, marked, restored };
}

/** Validate and merge against one pinned head for either the Worker or the publisher Action. */
export async function planSaveChanges(
  input: SaveInput,
  access: Access,
  current: readonly ({ value: unknown } | null)[],
  saveAliases: Aliases,
  exporterPin: (
    tooltip: Tooltip,
  ) => { value: unknown } | undefined | Promise<{ value: unknown } | undefined>,
  now = Date.now(),
  revisionHistory?: RevisionHistory,
): Promise<SavePlan> {
  const conflicts: SaveConflicts['conflicts'] = [];
  const tooltips: Tooltip[] = [];
  const writes: Record<string, Tooltip> = {};
  const changed: string[] = [];
  const carried: string[] = [];
  const kept: number[] = [];
  const marked: string[] = [];
  const restored: string[] = [];
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
    if (head && head.hash !== change.hash) throw new HttpError(502, 'Stored tooltip hash mismatch');
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
        conflicts.push({
          ...change,
          head,
          fields: result.conflicts.map(({ field }) => field),
          ...(revisionHistory && { headCommit: revisionHistory.headCommit }),
        });
        continue;
      }
      merged = result.merged;
    } else if (head && createdContent(head) === createdContent(next)) {
      // A new tooltip may have landed even when the browser never received its response.
      tooltips.push(head);
      continue;
    } else if (head || change.base) {
      conflicts.push({
        ...change,
        head,
        fields: ['$exists'],
        ...(head && revisionHistory && { headCommit: revisionHistory.headCommit }),
      });
      continue;
    }
    if (rebased) checkEdit(access, head, merged);
    // Against the real head, after the merge: what this commit does to the English revision.
    if (
      checkEnglishRevision(access, head, merged, input.noTranslationImpact === true, now) === 'kept'
    )
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
    const revisions = await verifyTranslationRevisions(
      change,
      head,
      merged,
      access,
      now,
      revisionHistory,
    );
    checkTranslationStamps(head, merged, merged.text.en, revisions.verified);
    if (change.translationRevisions && head && stableStringify(head) === stableStringify(merged)) {
      tooltips.push(merged);
      continue;
    }
    if (revisions.marked.length) marked.push(`${merged.hash}=${revisions.marked.join(',')}`);
    if (revisions.restored.length) restored.push(`${merged.hash}=${revisions.restored.join(',')}`);
    refuseUnlowerable(merged, await exporterPin(merged), 'saved', head);
    if (
      head &&
      head.text.en?.text !== merged.text.en?.text &&
      Object.keys(merged.text).some((lang) => lang !== 'en')
    ) {
      const result = carryNumberTranslations(head, merged, revisions.verified);
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
    if (
      (rebased || change.translationRevisions) &&
      !fields.length &&
      head &&
      stableStringify(head) === stableStringify(merged)
    )
      continue;
    writes[`tooltips/${merged.hash}.json`] = merged;
    changed.push(`${merged.hash}=${fields.join(',') || 'none'}`);
  }
  if (conflicts.length) return { conflicts };
  return {
    writes,
    tooltips,
    // Carried languages are attributed per tooltip, immediately after Clarity-Changed.
    message: `${input.message}\n\n${kept.length ? `Clarity-No-Translation-Impact: ${kept.join(',')}\n` : ''}Clarity-Changed: ${changed.join(';')}${carried.length ? `\nClarity-Carried: ${carried.join(';')}` : ''}${marked.length ? `\nClarity-Still-Correct: ${marked.join(';')}` : ''}${restored.length ? `\nClarity-Restored-Translation-Revision: ${restored.join(';')}` : ''}`,
  };
}
