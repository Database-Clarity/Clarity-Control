import { z } from 'zod';
import {
  affectedAliasCanonicals,
  aliasGroupFactsDigest,
  aliasGroupRemovalsCapability,
  aliasGroupsCapability,
  aliasGroupsPath,
  aliasGroupsRequestSchema,
  aliasGroupsResponseSchema,
  aliasGroupsSchema,
  aliasesSchema,
  composeAliases,
  emptyAliasGroups,
  hashSchema,
  languages,
  pushedSchema,
  resolveAlias,
  sandboxConflictsSchema,
  sharedSandboxPerks,
  sandboxPointersPath,
  stableStringify,
  tooltipSchema,
  usesEnglishFallback,
  validateTextWithReads,
  type AliasGroupArchive,
  type AliasGroupOperation,
  type AliasGroups,
  type AliasGroupsResponse,
  type AliasItems,
  type Aliases,
  type SandboxConflicts,
  type SandboxPointers,
  type Tooltip,
} from '@clarity/core';
import { aliasInputs, scopedAliases } from './catalog.js';
import { exporter, publisherPinPath } from './elementTags.js';
import { RefRace, type GitHub, type RepoFile } from './github.js';
import { body, HttpError, json, upstreamJson } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import { storedSandboxPointers } from './sandboxPointers.js';
import type { Identity } from './types.js';

const itemSchema = z.object({
  hash: hashSchema,
  name: z.string(),
  categoryId: z.string(),
  inGameDescription: z.string(),
  isEnhanced: z.boolean().optional(),
  exotic: z.boolean().optional(),
  plugCategoryHash: hashSchema.optional(),
  baseHash: hashSchema.optional(),
  dimBaseHash: hashSchema.optional(),
  itemHash: hashSchema.optional(),
  owners: z.array(hashSchema).optional(),
  sandboxPerkHashes: z.array(hashSchema).optional(),
});

/** Resolve the public generator once, then read every fact at that immutable commit. */
async function generatorFacts(github: GitHub) {
  const env = github.env;
  const repo = `${encodeURIComponent(env.GENERATOR_OWNER)}/${encodeURIComponent(env.GENERATOR_REPO)}`;
  let ref = env.GENERATOR_BRANCH;
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    github.spend();
    const commit = await fetch(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
      {
        headers: { 'User-Agent': 'clarity-editor', Accept: 'application/vnd.github+json' },
      },
    ).then(upstreamJson);
    ref = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }).parse(commit).sha;
  }
  const root = `https://raw.githubusercontent.com/${repo}/${ref}/templates/v2`;
  github.spend(4);
  const [items, generated, conflicts, categories] = await Promise.all([
    fetch(`${root}/items.json`)
      .then(upstreamJson)
      .then((v) => z.record(z.string(), itemSchema).parse(v)),
    fetch(`${root}/aliases.json`)
      .then(upstreamJson)
      .then((v) => aliasesSchema.parse(v)),
    fetch(`${root}/sandboxConflicts.json`)
      .then(upstreamJson)
      .then((v) => sandboxConflictsSchema.parse(v)),
    fetch(`${root}/categories.json`)
      .then(upstreamJson)
      .then((v) =>
        z.array(z.object({ id: z.string(), legacyType: z.string().optional() })).parse(v),
      ),
  ]);
  for (const [hash, item] of Object.entries(items))
    if (String(item.hash) !== hash) throw new HttpError(502, 'Generator item hash mismatch');
  return {
    items,
    generated,
    conflicts,
    types: new Map(categories.map((category) => [category.id, category.legacyType ?? category.id])),
  };
}

export function storedAliasGroups(file: RepoFile | null | undefined): AliasGroups {
  if (!file) return emptyAliasGroups();
  const parsed = aliasGroupsSchema.safeParse(file.value);
  if (!parsed.success) throw new HttpError(502, `Invalid ${aliasGroupsPath} in editor data`);
  return parsed.data;
}

function tooltip(file: RepoFile | null | undefined, hash: number): Tooltip | null {
  if (!file) return null;
  const result = tooltipSchema.parse(file.value);
  if (result.hash !== hash) throw new HttpError(502, 'Stored tooltip hash mismatch');
  return result;
}

const tooltipPath = (hash: number | string) => `tooltips/${hash}.json`;
const retainedPath = (archive: AliasGroupArchive, hash: string) =>
  `${archive.path.slice(0, -5)}/${hash}.json`;

/** Selection retains a complete member document. Acknowledgement cannot drop a locale. */
function checkSelection(
  canonical: number,
  members: number[],
  files: ReadonlyMap<number, RepoFile | null>,
  acknowledged: boolean,
  bulk: boolean,
  items: AliasItems,
) {
  const chosen = tooltip(files.get(canonical), canonical);
  let conflict = false;
  for (const hash of members) {
    const other = tooltip(files.get(hash), hash);
    if (!other) continue;
    for (const [lang, entry] of Object.entries(other.text)) {
      const selected = chosen?.text[lang as keyof Tooltip['text']];
      if (!selected)
        throw new HttpError(
          422,
          `Canonical ${canonical} lacks ${lang} from ${hash}; author it before grouping`,
        );
      if (
        entry.text.trim() &&
        (entry.text !== selected?.text ||
          stableStringify(entry.numbers ?? null) !== stableStringify(selected?.numbers ?? null))
      )
        conflict = true;
    }
    // Metadata and associations are part of the selected document too.
    const metadata = (value: Tooltip | null) => value && { ...value, hash: 0, text: {} };
    if (stableStringify(metadata(other)) !== stableStringify(metadata(chosen))) conflict = true;
  }
  if (
    bulk &&
    (conflict ||
      members.some(
        (hash) => items[hash]?.inGameDescription !== items[canonical]?.inGameDescription,
      ))
  )
    throw new HttpError(
      422,
      'Bulk acceptance requires identical in-game text and no tooltip conflicts',
    );
  if (conflict && !acknowledged)
    throw new HttpError(
      422,
      'Select a complete canonical tooltip and acknowledge conflicting content',
    );
}

/** Read the bounded tooltip census at the approval head. Actual resolver reads identify
 * incoming consumers, including title preparation and synthesized/nested imports.
 * Validate the proposed complete snapshot, not intermediate batch states.
 */
async function checkImports(
  github: GitHub,
  head: string,
  roots: ReadonlySet<number>,
  changed: ReadonlyMap<number, RepoFile | null>,
  beforeAliases: Aliases,
  afterAliases: Aliases,
  items: AliasItems,
  types: ReadonlyMap<string, string>,
) {
  if (!changed.size) return;
  const snapshot = await github.publishSnapshot([], [], [{ path: 'tooltips', depth: 1 }]);
  if (snapshot.head !== head)
    throw new HttpError(409, 'Data branch moved; review alias groups again');
  const hashes = (snapshot.trees[0] ?? [])
    .filter(({ name }) => /^(0|[1-9]\d*)\.json$/.test(name))
    .map(({ name }) => hashSchema.parse(Number(name.slice(0, -5))));
  const read = await github.files(hashes.map(tooltipPath), head);
  const before = new Map(hashes.map((hash, i) => [hash, tooltip(read[i], hash)]));
  const after = new Map(before);
  for (const [hash, file] of changed) after.set(hash, tooltip(file, hash));
  for (const lang of languages) {
    const catalog = (view: ReadonlyMap<number, Tooltip | null>, aliases: Aliases) =>
      new Proxy<Record<string, string>>(
        {},
        {
          get: (_target, key) => {
            if (typeof key !== 'string') return undefined;
            const hash = key === 'global' ? 1 : Number(key);
            if (!Number.isInteger(hash)) return undefined;
            const value = view.get(resolveAlias(hash, aliases));
            return value
              ? ((usesEnglishFallback(value, lang)
                  ? value.text.en?.text
                  : value.text[lang]?.text) ?? '')
              : undefined;
          },
        },
      );
    const oldCatalog = catalog(before, beforeAliases),
      newCatalog = catalog(after, afterAliases);
    const validate = (value: Tooltip, aliases: Aliases, imports: Record<string, string>) =>
      validateTextWithReads(
        (usesEnglishFallback(value, lang) ? value.text.en?.text : value.text[lang]?.text) ?? '',
        lang,
        {
          imports,
          variables: imports[2] ?? '',
          titles: imports[3] ?? '',
          type: types.get(items[value.hash]?.categoryId ?? value.custom?.categoryId ?? ''),
          lang,
        },
        false,
        value.hash,
        aliases,
      );
    for (const [hash, value] of after) {
      if (!value?.text[lang] || resolveAlias(hash, afterAliases) !== hash) continue;
      const old = before.get(hash);
      const prior = old?.text[lang] ? validate(old, beforeAliases, oldCatalog) : undefined;
      if (
        !roots.has(hash) &&
        ![...(prior?.reads.imports ?? [])].some(
          ([key, source]) =>
            changed.has(source) ||
            resolveAlias(key === 'global' ? 1 : Number(key), afterAliases) !== source,
        )
      )
        continue;
      const priorErrors = new Set(
        prior?.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
      );
      const errors = validate(value, afterAliases, newCatalog).issues.filter(
        (issue) =>
          issue.severity === 'error' && (roots.has(hash) || !priorErrors.has(issue.message)),
      );
      if (errors.length)
        throw new HttpError(
          422,
          `Tooltip ${hash} (${lang}) has invalid markup after grouping`,
          errors,
        );
    }
  }
}

function requirePublisher(pin: RepoFile | null | undefined, capability: string, message: string) {
  const capabilities = (pin?.value as { capabilities?: unknown } | undefined)?.capabilities;
  if (
    !exporter.publisherEnabled() ||
    !Array.isArray(capabilities) ||
    !capabilities.includes(capability)
  )
    throw new HttpError(409, message);
}

/** The newest archive that can restore exactly this membership. */
function restorationArchive(config: AliasGroups, members: number[]) {
  return [...(config.archives ?? [])]
    .reverse()
    .find(
      (entry) =>
        Object.keys(entry.files).length === members.length &&
        members.every((hash) => Object.hasOwn(entry.files, hash)),
    );
}

/** One atomic CAS on the reviewed head; a lost race is never replayed. */
async function commitDecisions(
  github: GitHub,
  head: string,
  writes: Record<string, unknown>,
  count: number,
  user: Identity,
  options: { blobRefs: Record<string, string>; deletions: string[] },
) {
  const message = `Update alias group decisions (${count}) by ${user.login}`;
  try {
    return await github.commit(head, writes, message, user, options);
  } catch (error) {
    if (error instanceof RefRace)
      throw new HttpError(409, 'Data branch moved; reload alias groups and review again');
    throw error;
  }
}

/**
 * One member leaves its group with a copy of the current document. Unlike the batch operations it
 * stays on the scoped alias path of grouped saves (Workers Free CPU). It needs no import census:
 * readers of the member already resolved to this text, with the same outgoing imports.
 */
async function removeMember(
  github: GitHub,
  user: Identity,
  head: string,
  { canonical, member }: Extract<AliasGroupOperation, { op: 'removeMember' }>,
  config: AliasGroups,
  picks: SandboxPointers | null,
) {
  const group = config.groups[canonical];
  const grouped = Object.values(config.groups).some(({ members }) => members.includes(member));
  if (!grouped && config.removed?.[member]?.canonical === canonical) {
    // A retry after a lost response: the removal is already saved, so answer it without writing.
    const [file] = await github.files([tooltipPath(member)], head);
    const stored = tooltip(file, member);
    return json({
      head,
      config,
      issues: [],
      affectedCanonicals: [],
      ...(stored ? { tooltip: stored } : {}),
    } satisfies AliasGroupsResponse);
  }
  if (!group?.members.includes(member))
    throw new HttpError(422, `${member} is not a member of this group`);
  const inputs = await aliasInputs(github);
  const items = inputs.items as AliasItems;
  const facts = itemSchema.safeParse(items[member]);
  if (!facts.success || facts.data.hash !== member)
    throw new HttpError(409, 'Alias facts changed; reload and retry');
  const shared = sharedSandboxPerks(
    member,
    { [member]: facts.data },
    inputs.aliases as Aliases,
    inputs.conflicts as SandboxConflicts,
  );
  if (shared.length)
    throw new HttpError(
      422,
      `Sandbox perk ${shared.join(', ')} is shared with another inventory item; ${member} stays grouped`,
    );
  const remaining = group.members.filter((hash) => hash !== member);
  const archive = restorationArchive(config, group.members);
  const kept = archive ? remaining.filter((hash) => archive.files[hash]) : [];
  const reducedPath = `migration-archives/alias-groups/${head}/${canonical}.json`;
  const [source, existing, occupied, pushed, ...blobs] = await github.files(
    [
      tooltipPath(canonical),
      tooltipPath(member),
      reducedPath,
      'live/pushed.json',
      ...kept.map((hash) => retainedPath(archive!, String(hash))),
    ],
    head,
  );
  if (existing)
    throw new HttpError(
      409,
      `Tooltip ${member} was authored after grouping; refusing to overwrite it`,
    );
  const next: AliasGroups = { ...config, groups: { ...config.groups } };
  const writes: Record<string, unknown> = {},
    blobRefs: Record<string, string> = {};
  next.removed = {
    ...next.removed,
    [member]: {
      canonical,
      by: { id: String(user.id), login: user.login },
      at: new Date().toISOString(),
    },
  };
  // Every language with its stamps, so no translation turns outdated. A group without a
  // document leaves the member without one. The reviewed Bungie text belongs to the canonical
  // item: it only carries over when the member's in-game text is the same.
  const current = tooltip(source, canonical);
  const copy: Tooltip | null = current && { ...current, hash: member };
  if (copy && items[canonical]?.inGameDescription !== facts.data.inGameDescription)
    delete copy.bungieSnapshot;
  if (copy) writes[tooltipPath(member)] = copy;
  // A publish marker from before the grouping would make the new entry look already published:
  // live still holds its stub, so Review must list it as new.
  const markers = pushedSchema.parse(pushed?.value ?? {});
  if (Object.hasOwn(markers, member)) {
    delete markers[member];
    writes['live/pushed.json'] = markers;
  }
  if (remaining.length < 2) delete next.groups[canonical];
  else {
    next.groups[canonical] = { ...group, members: remaining };
    if (archive) {
      // The remaining group stays restorable from the same original blobs.
      if (occupied) throw new HttpError(409, 'Archive already exists; refusing to overwrite it');
      const reduced: AliasGroupArchive = {
        path: reducedPath,
        files: Object.fromEntries(remaining.map((hash) => [hash, archive.files[hash] ?? null])),
      };
      for (const [i, hash] of kept.entries()) {
        const sha = archive.files[hash]!;
        if (blobs[i]?.sha !== sha) throw new HttpError(409, 'Group archive is missing or changed');
        blobRefs[retainedPath(reduced, String(hash))] = sha;
      }
      writes[reducedPath] = reduced;
      next.archives = [...(next.archives ?? []), reduced];
    }
  }
  // Revalidate what is left and every group that pairs with it, by base pointer or by name, also
  // through generator aliases: removing a base member must not silently disable an accepted
  // enhanced group.
  const generated = inputs.aliases as Aliases;
  const reach = new Set(group.members);
  for (const key of Object.keys(generated))
    if (reach.has(resolveAlias(Number(key), generated))) reach.add(Number(key));
  const named = (hash: number) => items[hash]?.name.trim().toLowerCase();
  const names = new Set([...reach].map(named));
  const related = Object.values(config.groups).filter(({ members }) =>
    members.some((hash) => reach.has(items[hash]?.baseHash ?? -1) || names.has(named(hash))),
  );
  let after: Aliases;
  try {
    after = scopedAliases(inputs, next, picks).extend([
      ...group.members,
      ...related.flatMap((other) => other.members),
    ]);
  } catch (error) {
    if (
      error instanceof HttpError &&
      Array.isArray(error.details) &&
      error.details.some((detail) => String(detail).includes('Enhanced member no longer shares'))
    )
      throw new HttpError(
        422,
        `${member} is the base of a grouped enhanced version; remove that enhanced version from its group first`,
      );
    throw error;
  }
  for (const hash of [canonical, member])
    if (resolveAlias(hash, after) !== hash)
      throw new HttpError(409, `The generator now aliases ${hash}; it has no entry of its own`);
  const before: Aliases = { ...after, [member]: { to: canonical, kind: 'name' } };
  writes[aliasGroupsPath] = aliasGroupsSchema.parse(next);
  const commit = await commitDecisions(github, head, writes, 1, user, { blobRefs, deletions: [] });
  return json({
    head: commit,
    config: next,
    issues: [],
    affectedCanonicals: affectedAliasCanonicals(before, after, items),
    ...(copy ? { tooltip: copy } : {}),
  } satisfies AliasGroupsResponse);
}

/** One approval, one head, one atomic CAS. Ref races never replay an approval. */
export async function aliasGroupsRoute(request: Request, github: GitHub, user: Identity) {
  const head = await github.head();
  requireAccess(await permissions(github, head), user, ['maintainer']);
  // The CAS head alone, for a single removal's confirm (no composed snapshot: Free CPU).
  if (request.method === 'GET' && new URL(request.url).searchParams.has('head'))
    return json({ head });
  const input = request.method === 'POST' ? await body(request, aliasGroupsRequestSchema) : null;
  if (input && input.expectedHead !== head)
    throw new HttpError(409, 'Alias groups changed since review; reload and retry');
  const [stored, picksFile, pin] = await github.files(
    [aliasGroupsPath, sandboxPointersPath, publisherPinPath],
    head,
  );
  const config = storedAliasGroups(stored);
  const only = input?.ops.length === 1 ? input.ops[0] : undefined;
  if (only?.op === 'removeMember') {
    // Older publishers reject the config's `removed` map, so removals wait for the new build.
    requirePublisher(
      pin,
      aliasGroupRemovalsCapability,
      'Removing a group member needs the updated publisher',
    );
    return removeMember(github, user, head, only, config, storedSandboxPointers(picksFile));
  }
  const { items, generated, conflicts, types } = await generatorFacts(github);
  const picks = storedSandboxPointers(picksFile);
  const compose = (groups: AliasGroups) => {
    try {
      return composeAliases(generated, groups, items, conflicts, picks);
    } catch (error) {
      throw new HttpError(
        422,
        'Alias groups cannot safely compose with generator aliases and sandbox picks',
        String(error),
      );
    }
  };
  const before = compose(config);
  if (!input)
    return json(
      aliasGroupsResponseSchema.parse({
        head,
        config,
        issues: before.issues,
        affectedCanonicals: [],
      }),
    );
  if (input.ops.some((op) => op.op !== 'reject')) {
    requirePublisher(
      pin,
      aliasGroupsCapability,
      'The active publisher must support aliasGroups before changing accepted groups',
    );
  }
  const next = structuredClone(config);
  const by = { id: String(user.id), login: user.login },
    at = new Date().toISOString();
  const touched = new Set<number>(),
    changedGroups = new Set<number>();
  const roots = new Set<number>();
  const changed = new Map<number, RepoFile | null>();
  const writes: Record<string, unknown> = {},
    blobRefs: Record<string, string> = {};
  const deletions = new Set<string>();
  const selections = input.ops.filter((op) =>
    ['accept', 'split', 'setCanonical'].includes(op.op),
  ).length;
  const plans = input.ops.map((op) => {
    if (op.op === 'removeMember') throw new HttpError(422, 'Remove one member per request');
    const group = 'canonical' in op ? config.groups[op.canonical] : undefined;
    const members = 'members' in op ? op.members : group?.members;
    if (!members) throw new HttpError(422, 'Alias group does not exist');
    for (const hash of members) {
      if (touched.has(hash))
        throw new HttpError(422, 'Batch operations must have disjoint members');
      touched.add(hash);
    }
    if ((op.op === 'ungroup' || op.op === 'setCanonical') && !group)
      throw new HttpError(422, 'Alias group does not exist');
    const archive =
      op.op === 'ungroup' || op.op === 'setCanonical'
        ? restorationArchive(config, members)
        : undefined;
    if ((op.op === 'ungroup' || op.op === 'setCanonical') && !archive)
      throw new HttpError(409, 'Group has no complete restoration archive');
    return { op, group, members, archive };
  });
  const read = await github.files([...touched].map(tooltipPath), head);
  const liveFiles = new Map([...touched].map((hash, i) => [hash, read[i] ?? null]));
  const files = new Map(liveFiles);
  const retainedPaths = plans.flatMap(({ archive }) =>
    archive
      ? Object.entries(archive.files)
          .filter(([, sha]) => sha !== null)
          .map(([hash]) => retainedPath(archive, hash))
      : [],
  );
  const retainedRead = await github.files(retainedPaths, head);
  const retainedFiles = new Map(retainedPaths.map((path, i) => [path, retainedRead[i] ?? null]));
  for (const { op, group, members, archive: previousArchive } of plans) {
    if ('factsDigest' in op) {
      if (members.some((hash) => !items[hash]))
        throw new HttpError(409, 'Alias facts changed; reload and retry');
      if ((await aliasGroupFactsDigest(members, items)) !== op.factsDigest)
        throw new HttpError(409, 'Alias facts changed since review; reload and retry');
    }
    if (op.op === 'reject') {
      next.rejected[op.factsDigest] = {
        by,
        at,
        ...(op.reason === undefined ? {} : { reason: op.reason }),
      };
      continue;
    }
    let originals: Record<string, string | null>;
    if (op.op === 'accept' || op.op === 'split') {
      // A manual accept overrides a rejection; keep the rejection entry as history.
      if (
        members.some((hash) =>
          Object.values(config.groups).some((existing) => existing.members.includes(hash)),
        )
      )
        throw new HttpError(422, 'Members already belong to an accepted group');
      originals = Object.fromEntries(members.map((hash) => [hash, files.get(hash)?.sha ?? null]));
    } else {
      const archive = previousArchive;
      if (!archive) throw new HttpError(409, 'Group has no complete restoration archive');
      originals = { ...archive.files };
      const hashes = Object.keys(originals).filter((hash) => originals[hash] !== null);
      const retained = hashes.map((hash) => retainedFiles.get(retainedPath(archive, hash)));
      for (const [i, hash] of hashes.entries()) {
        if (retained[i]?.sha !== originals[hash])
          throw new HttpError(409, 'Group archive is missing or changed');
      }
      for (const hash of members) {
        if (hash !== op.canonical && files.get(hash))
          throw new HttpError(
            409,
            `Tooltip ${hash} was authored after grouping; refusing to overwrite it`,
          );
      }
      if (op.op === 'ungroup') {
        if ((files.get(op.canonical)?.sha ?? null) !== originals[op.canonical])
          throw new HttpError(
            409,
            'Canonical was authored after grouping; refusing to overwrite it',
          );
        for (const [hash, sha] of Object.entries(originals)) {
          if (sha) blobRefs[tooltipPath(hash)] = sha;
          else if (liveFiles.get(Number(hash))) deletions.add(tooltipPath(hash));
          changed.set(
            Number(hash),
            sha ? (retainedFiles.get(retainedPath(archive, hash)) ?? null) : null,
          );
          roots.add(Number(hash));
        }
        delete next.groups[op.canonical];
        continue;
      }
      if (!members.includes(op.to))
        throw new HttpError(422, 'New canonical must belong to the group');
      hashes.forEach((hash, i) => {
        if (Number(hash) !== op.canonical) files.set(Number(hash), retained[i] ?? null);
      });
      originals[op.canonical] = files.get(op.canonical)?.sha ?? null;
      delete next.groups[op.canonical];
    }
    const canonical = op.op === 'setCanonical' ? op.to : op.canonical;
    checkSelection(
      canonical,
      members,
      files,
      op.acknowledgeConflicts === true,
      selections > 1,
      items,
    );
    const base = items[canonical];
    if (!base) throw new HttpError(422, 'Canonical facts are missing');
    const owner =
      base.categoryId === 'weapon-frame-exotic'
        ? [base.itemHash, ...(base.owners ?? [])].find(
            (candidate) =>
              candidate !== undefined &&
              members.every(
                (hash) =>
                  items[hash]?.itemHash === candidate || items[hash]?.owners?.includes(candidate),
              ),
          )
        : undefined;
    next.groups[canonical] = {
      members,
      kind: 'S',
      basis: {
        name: base.name,
        categoryId: base.categoryId,
        ...(owner === undefined ? {} : { exoticFrameOwner: owner }),
      },
      by,
      at,
      ...('note' in op && op.note !== undefined
        ? { note: op.note }
        : group?.note === undefined
          ? {}
          : { note: group.note }),
    };
    changedGroups.add(canonical);
    roots.add(canonical);
    // A manual accept of a removed member is the maintainer's explicit decision to regroup it.
    if (next.removed) {
      for (const hash of members) delete next.removed[hash];
      if (!Object.keys(next.removed).length) delete next.removed;
    }
    const archive: AliasGroupArchive = {
      path: `migration-archives/alias-groups/${head}/${canonical}.json`,
      files: originals,
    };
    if ((config.archives ?? []).some((entry) => entry.path === archive.path))
      throw new HttpError(409, 'Archive already exists; refusing to overwrite it');
    writes[archive.path] = archive;
    next.archives = [...(next.archives ?? []), archive];
    for (const [hash, sha] of Object.entries(originals))
      if (sha) blobRefs[retainedPath(archive, hash)] = sha;
    for (const hash of members) {
      if (hash !== canonical) {
        if (liveFiles.get(hash)) deletions.add(tooltipPath(hash));
        changed.set(hash, null);
      }
    }
    const selected = files.get(canonical);
    changed.set(canonical, selected ?? null);
    if (selected) blobRefs[tooltipPath(canonical)] = selected.sha;
    else if (liveFiles.get(canonical)) deletions.add(tooltipPath(canonical));
  }
  const after = compose(next);
  const issues = after.issues.filter((issue) => changedGroups.has(issue.canonical));
  if (issues.length)
    throw new HttpError(422, 'Selected members do not satisfy alias group rules', issues);
  // Removing a base group must not silently disable another accepted enhanced group.
  const priorIssues = new Set(before.issues.map((issue) => stableStringify(issue)));
  if (after.issues.some((issue) => !priorIssues.has(stableStringify(issue))))
    throw new HttpError(422, 'Operation would invalidate another accepted group', after.issues);
  const archivePaths = [
    ...Object.keys(writes),
    ...Object.keys(blobRefs).filter((path) => path.startsWith('migration-archives/')),
  ];
  if ((await github.files(archivePaths, head)).some(Boolean))
    throw new HttpError(409, 'Archive already exists; refusing to overwrite it');
  await checkImports(github, head, roots, changed, before.aliases, after.aliases, items, types);
  writes[aliasGroupsPath] = aliasGroupsSchema.parse(next);
  const commit = await commitDecisions(github, head, writes, input.ops.length, user, {
    blobRefs,
    deletions: [...deletions],
  });
  return json(
    aliasGroupsResponseSchema.parse({
      head: commit,
      config: next,
      issues: after.issues,
      affectedCanonicals: affectedAliasCanonicals(before.aliases, after.aliases, items),
    }),
  );
}
