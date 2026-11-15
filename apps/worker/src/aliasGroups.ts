import { z } from 'zod';
import {
  affectedAliasCanonicals,
  aliasGroupFactsDigest,
  aliasGroupsCapability,
  aliasGroupsPath,
  aliasGroupsRequestSchema,
  aliasGroupsResponseSchema,
  aliasGroupsSchema,
  aliasesSchema,
  composeAliases,
  emptyAliasGroups,
  hashSchema,
  markupImports,
  parseMarkup,
  resolveAlias,
  sandboxConflictsSchema,
  sandboxPointersPath,
  stableStringify,
  tooltipSchema,
  type AliasGroupArchive,
  type AliasGroups,
  type AliasItems,
  type Aliases,
  type Tooltip,
} from '@clarity/core';
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
  github.spend(3);
  const [items, generated, conflicts] = await Promise.all([
    fetch(`${root}/items.json`)
      .then(upstreamJson)
      .then((v) => z.record(z.string(), itemSchema).parse(v)),
    fetch(`${root}/aliases.json`)
      .then(upstreamJson)
      .then((v) => aliasesSchema.parse(v)),
    fetch(`${root}/sandboxConflicts.json`)
      .then(upstreamJson)
      .then((v) => sandboxConflictsSchema.parse(v)),
  ]);
  for (const [hash, item] of Object.entries(items))
    if (String(item.hash) !== hash) throw new HttpError(502, 'Generator item hash mismatch');
  return { items, generated, conflicts };
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

/** Use the real parser on the proposed alias graph, including nested and global imports. */
async function checkImports(
  github: GitHub,
  head: string,
  roots: number[],
  aliases: Aliases,
  files: ReadonlyMap<number, RepoFile | null>,
) {
  if (!roots.length) return;
  const known = new Map<number, Tooltip | null>(
    [...files].map(([hash, file]) => [hash, tooltip(file, hash)]),
  );
  const visited = new Set<number>();
  let pending = [...roots, 1, 2, 3];
  while (pending.length) {
    const hashes = [...new Set(pending.map((hash) => resolveAlias(hash, aliases)))].filter(
      (hash) => !visited.has(hash),
    );
    hashes.forEach((hash) => visited.add(hash));
    const missing = hashes.filter((hash) => !known.has(hash));
    const read = await github.files(missing.map(tooltipPath), head);
    missing.forEach((hash, i) => known.set(hash, tooltip(read[i], hash)));
    pending = hashes.flatMap((hash) =>
      Object.values(known.get(hash)?.text ?? {}).flatMap((entry) =>
        markupImports(entry.text).flatMap((line) => {
          const from = line.match(/ from (\d+|global) *$/)?.[1];
          return from ? [from === 'global' ? 1 : Number(from)] : [];
        }),
      ),
    );
  }
  for (const hash of roots) {
    for (const [lang, entry] of Object.entries(known.get(hash)?.text ?? {})) {
      const text = (h: number) =>
        known.get(resolveAlias(h, aliases))?.text[lang as keyof Tooltip['text']]?.text ?? '';
      const imports = Object.fromEntries(
        [...new Set([...known.keys(), ...Object.keys(aliases).map(Number)])].map((h) => [
          h === 1 ? 'global' : String(h),
          text(h),
        ]),
      );
      const errors = parseMarkup(entry.text, {
        variables: text(2),
        titles: text(3),
        imports,
      }).diagnostics.filter((issue) => issue.severity === 'error');
      if (errors.length)
        throw new HttpError(
          422,
          `Canonical ${hash} (${lang}) has invalid markup after grouping`,
          errors,
        );
    }
  }
}

/** One approval, one head, one atomic CAS. Ref races never replay an approval. */
export async function aliasGroupsRoute(request: Request, github: GitHub, user: Identity) {
  const head = await github.head();
  requireAccess(await permissions(github, head), user, ['maintainer']);
  const input = request.method === 'POST' ? await body(request, aliasGroupsRequestSchema) : null;
  if (input && input.expectedHead !== head)
    throw new HttpError(409, 'Alias groups changed since review; reload and retry');
  const [stored, picksFile, pin] = await github.files(
    [aliasGroupsPath, sandboxPointersPath, publisherPinPath],
    head,
  );
  const config = storedAliasGroups(stored);
  const { items, generated, conflicts } = await generatorFacts(github);
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
    const capabilities = (pin?.value as { capabilities?: unknown } | undefined)?.capabilities;
    if (
      !exporter.publisherEnabled() ||
      !Array.isArray(capabilities) ||
      !capabilities.includes(aliasGroupsCapability)
    )
      throw new HttpError(
        409,
        'The active publisher must support aliasGroups before changing accepted groups',
      );
  }
  const next = structuredClone(config);
  const by = { id: String(user.id), login: user.login },
    at = new Date().toISOString();
  const touched = new Set<number>(),
    changedGroups = new Set<number>();
  const roots: number[] = [];
  const writes: Record<string, unknown> = {},
    blobRefs: Record<string, string> = {};
  const deletions = new Set<string>();
  const selections = input.ops.filter((op) =>
    ['accept', 'split', 'setCanonical'].includes(op.op),
  ).length;
  const plans = input.ops.map((op) => {
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
        ? [...(config.archives ?? [])]
            .reverse()
            .find(
              (entry) =>
                Object.keys(entry.files).length === members.length &&
                members.every((hash) => Object.hasOwn(entry.files, hash)),
            )
        : undefined;
    if ((op.op === 'ungroup' || op.op === 'setCanonical') && !archive)
      throw new HttpError(409, 'Group has no complete restoration archive');
    return { op, group, members, archive };
  });
  const read = await github.files([...touched].map(tooltipPath), head);
  const files = new Map([...touched].map((hash, i) => [hash, read[i] ?? null]));
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
          else deletions.add(tooltipPath(hash));
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
    roots.push(canonical);
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
      if (hash !== canonical) deletions.add(tooltipPath(hash));
    }
    const selected = files.get(canonical);
    if (selected) blobRefs[tooltipPath(canonical)] = selected.sha;
    else deletions.add(tooltipPath(canonical));
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
  await checkImports(github, head, roots, after.aliases, files);
  writes[aliasGroupsPath] = aliasGroupsSchema.parse(next);
  let commit: string;
  try {
    commit = await github.commit(
      head,
      writes,
      `Update alias group decisions (${input.ops.length}) by ${user.login}`,
      user,
      { blobRefs, deletions: [...deletions] },
    );
  } catch (error) {
    if (error instanceof RefRace)
      throw new HttpError(409, 'Data branch moved; reload alias groups and review again');
    throw error;
  }
  return json(
    aliasGroupsResponseSchema.parse({
      head: commit,
      config: next,
      issues: after.issues,
      affectedCanonicals: affectedAliasCanonicals(before.aliases, after.aliases, items),
    }),
  );
}
