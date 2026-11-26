import { z } from 'zod';
import {
  applySandboxPicks,
  aliasGroupsCapability,
  aliasGroupsPath,
  aliasGroupsSchema,
  emptySandboxPointers,
  hasSandboxTargets,
  hashSchema,
  mergeSandboxPointers,
  permissionsSchema,
  sandboxConflictsFile,
  sandboxConflictsSchema,
  sandboxPickSchema,
  sandboxPointerProblem,
  sandboxPointersCapability,
  sandboxPointersPath,
  sandboxPointersSchema,
  isSandboxDecision,
  samePick,
  type Aliases,
  type SandboxConflicts,
  type SandboxPointers,
} from '@clarity/core';
import { aliasCatalog, aliasInputs, consumerAliases, scopedAliases, source } from './catalog.js';
import { exporter, publisherPinPath } from './elementTags.js';
import { blobContent, blobSha, RefRace, type GitHub, type RepoFile } from './github.js';
import { body, HttpError, json, upstreamJson } from './http.js';
import { requireAccess } from './permissions.js';
import type { Identity } from './types.js';

/** The generator's shared-sandbox-perk table; `budget` counts the subrequest. */
export async function loadSandboxConflicts(
  env: GitHub['env'],
  budget?: Pick<GitHub, 'spend'>,
  revision?: string,
): Promise<SandboxConflicts> {
  budget?.spend();
  return fetch(`${source(env, revision)}/${sandboxConflictsFile}`)
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
 * S1 composition from files read at the consumer's immutable head. Group config requires the
 * complete catalog and conflicts at one pinned generator revision, including collision checks.
 * Without groups, preserve the existing fast path: conflicts cost one request only for targets.
 */
export async function withSandboxPointers(
  github: GitHub,
  aliases: Aliases,
  file: RepoFile | null | undefined,
  groupsFile?: RepoFile | null,
  generated?: Awaited<ReturnType<typeof aliasCatalog>>,
): Promise<Aliases> {
  const pointers = storedSandboxPointers(file);
  if (groupsFile) {
    const groups = storedAliasGroups(groupsFile)!;
    generated ??= await aliasCatalog(github);
    const conflicts = await loadSandboxConflicts(github.env, github, generated.revision);
    return consumerAliases(generated.aliases, groups, generated.items, conflicts, pointers);
  }
  if (!hasSandboxTargets(pointers)) return aliases;
  return mergeSandboxPointers(aliases, await loadSandboxConflicts(github.env, github), pointers);
}

export function storedAliasGroups(file: RepoFile | null | undefined) {
  if (!file) return null;
  const parsed = aliasGroupsSchema.safeParse(file.value);
  if (!parsed.success) throw new HttpError(502, `Invalid ${aliasGroupsPath} in editor data`);
  return parsed.data;
}

/** A fresh scope per request/attempt; extending it replaces the immutable alias map. */
export async function consumerAliasScope(
  github: GitHub,
  groupsFile: RepoFile | null | undefined,
  pointersFile: RepoFile | null | undefined,
  hashes: readonly number[],
  includeCategories = false,
  options?: Parameters<typeof aliasInputs>[2],
) {
  const groups = storedAliasGroups(groupsFile);
  if (!groups) return undefined;
  const scope = scopedAliases(
    await aliasInputs(github, includeCategories, options),
    groups,
    storedSandboxPointers(pointersFile),
  );
  scope.extend(hashes);
  return scope;
}

export function pinMergesAliasGroups(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(aliasGroupsCapability);
}

/** Shared with alias mutation admission: an installed exporter must understand accepted groups. */
export function refuseUnsupportedAliasGroups(file: RepoFile | null | undefined, pin: unknown) {
  const groups = storedAliasGroups(file);
  if (groups && Object.keys(groups.groups).length && !pinMergesAliasGroups(pin))
    throw new HttpError(
      409,
      `The installed publisher lacks the "${aliasGroupsCapability}" capability`,
    );
}

/**
 * Push-live: the merged aliases (as withSandboxPointers) plus every key the picks file names,
 * whose live entries the export recomputes (core mergeLivePerks). No picks file: no keys, so the
 * live file merges exactly as in v2; the conflicts are read only when a pick points somewhere.
 */
export async function pushSandboxPicks(
  github: GitHub,
  aliases: Aliases,
  file: RepoFile | null | undefined,
): Promise<{ aliases: Aliases; keys: string[] }> {
  const pointers = storedSandboxPointers(file);
  return {
    aliases: hasSandboxTargets(pointers)
      ? mergeSandboxPointers(aliases, await loadSandboxConflicts(github.env, github), pointers)
      : aliases,
    keys: pointers ? Object.keys(pointers.pointers) : [],
  };
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

const candidatesSchema = z.array(hashSchema);

/** A generator file as a plain object; entries are validated where they are read. */
async function generatorRecord(github: GitHub, file: string): Promise<Record<string, unknown>> {
  github.spend();
  const value = await fetch(`${source(github.env)}/${file}`).then(upstreamJson);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(502, 'Invalid upstream data');
  return value as Record<string, unknown>;
}

const aliasEntrySchema = z.object({ to: hashSchema }).passthrough();
/** A candidate's canonical tooltip, validating only the generator alias entries it follows. */
function canonical(hash: number, aliases: Record<string, unknown>): number {
  const seen = new Set<number>();
  while (Object.hasOwn(aliases, String(hash))) {
    if (seen.has(hash)) throw new HttpError(502, 'Invalid upstream data');
    seen.add(hash);
    const entry = aliasEntrySchema.safeParse(aliases[String(hash)]);
    if (!entry.success) throw new HttpError(502, 'Invalid upstream data');
    hash = entry.data.to;
  }
  return hash;
}

/**
 * Whether a stored tooltip file is tooltip `hash` with text in some language. Files on the data
 * branch are schema-checked when saved; this reads only the fields the pick depends on.
 */
function savedWithText(value: unknown, hash: number): boolean {
  const tooltip = value as { hash?: unknown; text?: Record<string, { text?: unknown }> } | null;
  return (
    !!tooltip &&
    tooltip.hash === hash &&
    !!tooltip.text &&
    typeof tooltip.text === 'object' &&
    Object.values(tooltip.text).some(
      (entry) => typeof entry?.text === 'string' && entry.text.trim() !== '',
    )
  );
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
  // A malformed body is reported only after the role check: non-maintainers always get 403.
  let input: z.infer<typeof updateSchema> | null = null;
  let invalid: unknown;
  if (request.method === 'PUT')
    input = await body(request, updateSchema, 200_000).catch((error: unknown) => {
      invalid = error;
      return null;
    });
  let generator: { aliases: Aliases; conflicts: Record<string, unknown> } | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const publisher = exporter.publisherEnabled();
    const [permissionFile, file, pin, groups] = await github.files(
      ['config/permissions.json', sandboxPointersPath, publisherPinPath, aliasGroupsPath],
      head,
    );
    if (!permissionFile) throw new HttpError(502, 'Required repository file is missing');
    requireAccess(permissionsSchema.parse(permissionFile.value), user, ['maintainer']);
    if (invalid) throw invalid;
    storedAliasGroups(groups);
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
    if (publisher) refuseUnsupportedAliasGroups(groups, pin?.value);
    // CPU (Workers FREE plan, 10 ms): the route reads only the entries it checks, so it validates
    // those, not the whole generator files (the aliases alone are ~6,000 entries). Every lookup
    // below is an own-key test, and a candidate list is schema-checked before it is stored.
    const grouped = groups ? await aliasCatalog(github) : undefined;
    if (grouped)
      generator = {
        aliases: grouped.aliases,
        conflicts: await loadSandboxConflicts(github.env, github, grouped.revision),
      };
    else
      generator ??= {
        aliases: (await generatorRecord(github, 'aliases.json')) as Aliases,
        conflicts: await generatorRecord(github, sandboxConflictsFile),
      };
    const aliases = grouped
      ? consumerAliases(
          grouped.aliases,
          storedAliasGroups(groups),
          grouped.items,
          generator.conflicts as SandboxConflicts,
        )
      : generator.aliases;
    const current = stored ?? emptySandboxPointers();
    const problems: string[] = [];
    const conflicts: SandboxConflicts = {};
    for (const [hash, pick] of Object.entries(input.picks)) {
      const kept = current.pointers[hash];
      // An undone tombstone is no decision: picking that perk again is a change.
      const changed = !kept || !samePick(kept, pick);
      // An unchanged pick stays valid as stored (owner: a pick keeps working after its set changes),
      // except that its target must not become a decided perk itself: every exporter's merge would
      // then drop it (core sandboxPointerProblem, "another shared sandbox perk").
      if (!changed) {
        if ('to' in pick && Object.hasOwn(input.picks, String(pick.to)))
          problems.push(
            `${pick.to} is the target of the pick for ${hash}; change or undo that pick first`,
          );
        continue;
      }
      if (!Object.hasOwn(generator.conflicts, hash)) {
        problems.push(`${hash} is not a shared sandbox perk`);
        continue;
      }
      const listed = candidatesSchema.safeParse(generator.conflicts[hash]);
      if (!listed.success) throw new HttpError(502, 'Invalid upstream data');
      conflicts[hash] = listed.data;
      if ('to' in pick) {
        const problem = sandboxPointerProblem(
          hash,
          pick.to,
          aliases,
          generator.conflicts as SandboxConflicts,
          input.picks,
        );
        if (problem) problems.push(`${hash} ${problem}`);
        // A new or changed pick names one of the tooltips that share the effect now. (A kept pick
        // keeps working after its set changes; the worklist flags it.)
        else if (!listed.data.some((candidate) => canonical(candidate, aliases) === pick.to))
          problems.push(
            `${hash} points at ${pick.to}, which is not one of the tooltips sharing it`,
          );
      }
    }
    if (problems.length) throw new HttpError(422, 'Invalid sandbox picks', problems);
    // Changed `to` picks must name a saved tooltip with text, and no picked sandbox perk may have
    // its own tooltip (it would be both an alias and a canonical entry). Batched: flat cost.
    const changedTo = Object.entries(input.picks).filter(([hash, pick]) => {
      const kept = current.pointers[hash];
      return 'to' in pick && !(kept && 'to' in kept && kept.to === pick.to);
    });
    // Re-read at every attempt's head: a target checked at an older head may have lost its text.
    const targets = [...new Set(changedTo.map(([, pick]) => ('to' in pick ? pick.to : 0)))];
    const ownHashes = changedTo.map(([hash]) => hash);
    if (targets.length || ownHashes.length) {
      const files = await github.files(
        [...targets, ...ownHashes].map((hash) => `tooltips/${hash}.json`),
        head,
      );
      for (const [index, hash] of targets.entries()) {
        if (!savedWithText(files[index]?.value, hash))
          problems.push(`Tooltip ${hash} does not exist or has no text`);
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
    const count = Object.values(next.pointers).filter(isSandboxDecision).length;
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
