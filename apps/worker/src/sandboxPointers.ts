import { z } from 'zod';
import {
  applySandboxPicks,
  emptySandboxPointers,
  hasSandboxTargets,
  hasTooltipText,
  mergeSandboxPointers,
  permissionsSchema,
  sandboxConflictsFile,
  sandboxConflictsSchema,
  sandboxPickSchema,
  sandboxPointerProblem,
  sandboxPointersCapability,
  sandboxPointersPath,
  sandboxPointersSchema,
  tooltipSchema,
  type Aliases,
  type SandboxConflicts,
  type SandboxPointers,
} from '@clarity/core';
import { loadAliases, source } from './catalog.js';
import { exporter, publisherPinPath } from './elementTags.js';
import { blobContent, blobSha, RefRace, type GitHub, type RepoFile } from './github.js';
import { body, HttpError, json, upstreamJson } from './http.js';
import { requireAccess } from './permissions.js';
import type { Identity } from './types.js';

/** The generator's shared-sandbox-perk table; `budget` counts the subrequest. */
export async function loadSandboxConflicts(
  env: GitHub['env'],
  budget?: Pick<GitHub, 'spend'>,
): Promise<SandboxConflicts> {
  budget?.spend();
  return fetch(`${source(env)}/${sandboxConflictsFile}`)
    .then(upstreamJson)
    .then((value) => sandboxConflictsSchema.parse(value));
}

/** The stored picks; an absent file is no picks. A malformed file fails closed (502). */
export function storedSandboxPointers(file: RepoFile | null | undefined): SandboxPointers | null {
  if (!file) return null;
  const parsed = sandboxPointersSchema.safeParse(file.value);
  if (!parsed.success) throw new HttpError(502, `Invalid ${sandboxPointersPath} in editor data`);
  return parsed.data;
}

/**
 * Generator aliases plus the picks stored at a data commit (see core `mergeSandboxPointers`).
 * Only when a pick points at a tooltip does this fetch the generator's conflicts (1 subrequest);
 * with no file or only "no tooltip" picks it returns `aliases` itself, at no cost.
 */
export async function withSandboxPointers(
  github: GitHub,
  aliases: Aliases,
  file: RepoFile | null | undefined,
): Promise<Aliases> {
  const pointers = storedSandboxPointers(file);
  if (!hasSandboxTargets(pointers)) return aliases;
  return mergeSandboxPointers(aliases, await loadSandboxConflicts(github.env, github), pointers);
}

/**
 * Whether the active exporter merges picks into its output: always while this Worker's push-live
 * exports; once the publisher is on, only a build whose PIN declares the capability. Saving picks
 * an exporter would ignore is refused, so the editor's digests never disagree with the exporter's.
 */
export function pinMergesSandboxPointers(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(sandboxPointersCapability);
}

const revisionSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .nullable();
const updateSchema = z
  .object({
    revision: revisionSchema,
    // Every staged decision, keyed by sandbox perk hash; an omitted hash is undone.
    picks: z.record(z.string().regex(/^(0|[1-9]\d*)$/), sandboxPickSchema),
  })
  .strict();

export const sandboxPointersChangedMessage =
  'Sandbox picks changed since they were loaded; reload and retry';

/**
 * GET returns the picks with the blob SHA they were read at (`revision`, null while the file does
 * not exist) and whether the active exporter applies them. PUT sends the complete set of picks and
 * that revision; a stale revision (re-checked on every ref-race retry) is refused with 409. Both are
 * maintainer-only, re-checked against permissions at the head that is written. The commit is
 * authored by the maintainer (GitHub.commit), committed by the app.
 *
 * Subrequests: GET = token 1 + head 1 + one batched read (permissions, picks, PIN) 1 = 3.
 * PUT adds generator aliases 1 + conflicts 1, the tooltip check ceil(n/500), and per attempt
 * head 1, the batched read 1, commit 4 (tree read, tree, commit, ref): 9 + ceil(n/500) first try.
 */
export async function sandboxPointersRoute(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const input = request.method === 'PUT' ? await body(request, updateSchema, 200_000) : null;
  let generator: { aliases: Aliases; conflicts: SandboxConflicts } | undefined;
  const checkedTargets = new Set<number>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const publisher = exporter.publisherEnabled();
    const [permissionFile, file, pin] = await github.files(
      ['config/permissions.json', sandboxPointersPath, ...(publisher ? [publisherPinPath] : [])],
      head,
    );
    if (!permissionFile) throw new HttpError(502, 'Required repository file is missing');
    requireAccess(permissionsSchema.parse(permissionFile.value), user, ['maintainer']);
    const stored = storedSandboxPointers(file);
    const revision = file?.sha ?? null;
    const exporting = !publisher || pinMergesSandboxPointers(pin?.value);
    if (!input) return json({ revision, pointers: stored ?? emptySandboxPointers(), exporting });
    if (input.revision !== revision) throw new HttpError(409, sandboxPointersChangedMessage);
    if (!exporting)
      throw new HttpError(
        409,
        `The publisher installed in the data branch does not apply sandbox picks yet (${publisherPinPath} lacks the "${sandboxPointersCapability}" capability); picks cannot be saved until it is updated.`,
      );
    if (!generator) {
      const [aliases, conflicts] = await Promise.all([
        loadAliases(github.env, github),
        loadSandboxConflicts(github.env, github),
      ]);
      generator = { aliases, conflicts };
    }
    const { aliases, conflicts } = generator;
    const current = stored ?? emptySandboxPointers();
    const problems: string[] = [];
    for (const [hash, pick] of Object.entries(input.picks)) {
      const kept = current.pointers[hash];
      const changed = !kept || ('to' in pick ? !('to' in kept) || kept.to !== pick.to : 'to' in kept);
      // An unchanged pick stays valid as stored (owner: a pick keeps working after its set changes).
      if (!changed) continue;
      if (!Object.hasOwn(conflicts, hash)) {
        problems.push(`${hash} is not a shared sandbox perk`);
        continue;
      }
      if ('to' in pick) {
        const problem = sandboxPointerProblem(hash, pick.to, aliases, conflicts, input.picks);
        if (problem) problems.push(`${hash} ${problem}`);
      }
    }
    if (problems.length) throw new HttpError(422, 'Invalid sandbox picks', problems);
    // Changed `to` picks must name a saved tooltip with text, and no picked sandbox perk may have
    // its own tooltip (it would be both an alias and a canonical entry). Batched: flat cost.
    const changedTo = Object.entries(input.picks).filter(([hash, pick]) => {
      const kept = current.pointers[hash];
      return 'to' in pick && !(kept && 'to' in kept && kept.to === pick.to);
    });
    const targets = [
      ...new Set(changedTo.map(([, pick]) => ('to' in pick ? pick.to : 0))),
    ].filter((hash) => !checkedTargets.has(hash));
    const ownHashes = changedTo.map(([hash]) => hash);
    if (targets.length || ownHashes.length) {
      const files = await github.files(
        [...targets, ...ownHashes].map((hash) => `tooltips/${hash}.json`),
        head,
      );
      for (const [index, hash] of targets.entries()) {
        const value = files[index]?.value;
        const tooltip = value === undefined ? undefined : tooltipSchema.safeParse(value).data;
        if (!tooltip || tooltip.hash !== hash || !hasTooltipText(tooltip))
          problems.push(`Tooltip ${hash} does not exist or has no text`);
        else checkedTargets.add(hash);
      }
      for (const [index, hash] of ownHashes.entries()) {
        if (files[targets.length + index])
          problems.push(`${hash} has its own tooltip; edit that tooltip instead`);
      }
      if (problems.length) throw new HttpError(422, 'Invalid sandbox picks', problems);
    }
    const next = applySandboxPicks(
      current,
      input.picks,
      conflicts,
      user.id,
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
    const count = Object.keys(next.pointers).length;
    try {
      const commit = await github.commit(
        head,
        { [sandboxPointersPath]: next },
        `Update sandbox perk picks (${count}) by ${user.login}`,
        user,
      );
      // The blob SHA of the bytes just committed: the next save's revision, without a re-read.
      const saved = await blobSha(blobContent(next));
      return json({ commit, revision: saved, pointers: next, exporting });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload sandbox picks and retry');
}
