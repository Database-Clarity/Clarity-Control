import { z } from 'zod';
import { hashSchema } from './legacy.js';
import { aliasesSchema, resolveAlias, type Aliases } from './aliases.js';
import { timestampSchema, type Tooltip } from './schemas.js';
import { stableStringify } from './contentHash.js';
import {
  mergeSandboxPointers,
  sandboxConflictsSchema,
  sandboxPointersSchema,
  type SandboxConflicts,
  type SandboxPointers,
} from './sandboxPointers.js';

export * from './aliasGroupOperations.js';

export const aliasGroupsPath = 'config/alias-groups.json';
export const aliasGroupsCapability = 'aliasGroups';

const hashKey = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => Number(v) <= 0xffffffff);
const actor = z.object({ id: z.string().min(1), login: z.string().min(1) }).strict();
/** Immutable archive manifest. Null records an absent tooltip; a blob preserves exact bytes.
 * Keep all references through split, recanonicalization, and ungroup. Never overwrite a manifest.
 * Each files key identifies tooltips/<hash>.json; blobs must also be retained in the archive tree.
 */
export const aliasGroupArchiveSchema = z
  .object({
    path: z
      .string()
      .regex(/^migration-archives\/alias-groups\/[0-9a-f]{40}\/(0|[1-9]\d*)\.json$/)
      .refine((path) => Number(path.split('/').at(-1)?.replace('.json', '')) <= 0xffffffff),
    files: z
      .record(
        hashKey,
        z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .nullable(),
      )
      .refine((files) => Object.keys(files).length > 0),
  })
  .strict();
export type AliasGroupArchive = z.infer<typeof aliasGroupArchiveSchema>;
export const aliasGroupsSchema = z
  .object({
    version: z.literal(1),
    groups: z.record(
      hashKey,
      z
        .object({
          members: z
            .array(hashSchema)
            .min(2)
            .refine((v) => new Set(v).size === v.length),
          kind: z.enum(['S', 'X']),
          basis: z
            .object({
              name: z.string(),
              categoryId: z.string(),
              exoticFrameOwner: hashSchema.optional(),
            })
            .strict(),
          by: actor,
          at: timestampSchema,
          note: z.string().optional(),
        })
        .strict(),
    ),
    rejected: z.record(
      z.string().regex(/^[0-9a-f]{64}$/),
      z
        .object({
          by: actor,
          at: timestampSchema,
          reason: z.string().optional(),
        })
        .strict(),
    ),
    archives: z.array(aliasGroupArchiveSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    const paths = value.archives?.map((archive) => archive.path) ?? [];
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate alias archive path' });
    for (const [key, group] of Object.entries(value.groups)) {
      if (!group.members.includes(Number(key)))
        ctx.addIssue({ code: 'custom', message: 'Canonical must be a member' });
      for (const member of group.members) {
        if (seen.has(member)) ctx.addIssue({ code: 'custom', message: 'Overlapping alias groups' });
        seen.add(member);
      }
    }
  });
export type AliasGroups = z.infer<typeof aliasGroupsSchema>;
export const emptyAliasGroups = (): AliasGroups => ({ version: 1, groups: {}, rejected: {} });

export const aliasGroupIssueSchema = z
  .object({ canonical: hashSchema, member: hashSchema.optional(), reason: z.string().min(1) })
  .strict();
export type AliasGroupIssue = z.infer<typeof aliasGroupIssueSchema>;

/** GET and successful POST share a snapshot. GET has no affected canonicals.
 * POST lists both old and new editor identities, including changes to incoming sandbox stubs.
 * Archive blob references are metadata, never consumer export input.
 */
export const aliasGroupsResponseSchema = z
  .object({
    head: z.string().regex(/^[0-9a-f]{40}$/),
    config: aliasGroupsSchema,
    issues: z.array(aliasGroupIssueSchema),
    affectedCanonicals: z.array(hashSchema).refine((v) => new Set(v).size === v.length),
  })
  .strict();
export type AliasGroupsResponse = z.infer<typeof aliasGroupsResponseSchema>;

/** Supply complete generator facts from one pinned revision, keyed by the item's own hash.
 * Explicit enhanced/exotic flags take precedence over legacy category fallbacks. Never derive
 * missing plug categories, exotic owners, or enhanced base pointers from display names.
 */
export interface AliasItem {
  hash: number;
  name: string;
  categoryId: string;
  inGameDescription: string;
  isEnhanced?: boolean;
  exotic?: boolean;
  plugCategoryHash?: number;
  baseHash?: number;
  dimBaseHash?: number;
  itemHash?: number;
  owners?: number[];
}
export type AliasItems = Readonly<Record<string, AliasItem>>;

/** Rejections expire when membership or authoritative grouping facts change. This digest is
 * recomputed by the server from pinned generator facts, never from a submitted proposal.
 */
export async function aliasGroupFactsDigest(members: number[], items: AliasItems): Promise<string> {
  const selected = z
    .array(hashSchema)
    .min(2)
    .refine((values) => new Set(values).size === values.length)
    .parse(members);
  const facts = [...selected]
    .sort((a, b) => a - b)
    .map((hash) => {
      const item = items[hash];
      if (!item || item.hash !== hash) throw new Error(`Missing alias facts for ${hash}`);
      return {
        hash,
        name: item.name,
        categoryId: item.categoryId,
        inGameDescription: item.inGameDescription,
        isEnhanced: item.isEnhanced,
        exotic: item.exotic,
        plugCategoryHash: item.plugCategoryHash,
        baseHash: item.baseHash,
        dimBaseHash: item.dimBaseHash,
        itemHash: item.itemHash,
        owners: item.owners ? [...item.owners].sort((a, b) => a - b) : undefined,
      };
    });
  const bytes = new TextEncoder().encode(stableStringify(facts));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Generator-resolved enhanced mod; an absent/ambiguous base is never inferred by name. */
export function isPairedEnhancedMod(item: Pick<AliasItem, 'categoryId' | 'baseHash'>): boolean {
  return item.categoryId === 'weapon-mod-enhanced' && item.baseHash !== undefined;
}
const enhanced = (item: AliasItem) =>
  !exotic(item) && (item.isEnhanced ?? item.categoryId.includes('-enhanced'));
const exotic = (item: AliasItem) => item.exotic ?? item.categoryId.endsWith('-exotic');
const name = (item: AliasItem) => item.name.trim().toLowerCase();
const inScope = (item: AliasItem) =>
  /^(weapon-(perk|trait|mod)|armor-mod|subclass)(-|$)/.test(item.categoryId);
const subclass = (item: AliasItem) => /^subclass(-|$)/.test(item.categoryId);
const owns = (item: AliasItem, owner: number) =>
  item.itemHash === owner || Boolean(item.owners?.includes(owner));
const numbered = (item: AliasItem) => / (II|III|IV)$/.test(item.name);

/** Revalidate persisted decisions against current facts. Generated aliases always win. */
export function effectiveAliases(
  generated: Aliases,
  input: AliasGroups,
  items: AliasItems,
): {
  aliases: Aliases;
  issues: AliasGroupIssue[];
} {
  const groups = aliasGroupsSchema.parse(input);
  const aliases: Aliases = { ...aliasesSchema.parse(generated) };
  const issues: AliasGroupIssue[] = [];
  for (const [key, item] of Object.entries(items)) {
    if (String(item.hash) !== key) throw new Error(`Alias fact key does not match hash: ${key}`);
  }
  for (const [key, group] of Object.entries(groups.groups)) {
    const canonical = Number(key),
      base = items[key];
    const frameOwner = group.basis.exoticFrameOwner;
    if (group.kind === 'X') {
      issues.push({ canonical, reason: 'Cross-category alias groups are disabled' });
      continue;
    }
    const exoticFrame = Boolean(
      base &&
      group.kind === 'S' &&
      base.categoryId === 'weapon-frame-exotic' &&
      frameOwner !== undefined &&
      owns(base, frameOwner) &&
      !numbered(base),
    );
    if (!base || (!inScope(base) && !exoticFrame) || generated[key]) {
      issues.push({ canonical, reason: 'Canonical missing, excluded, or generated alias' });
      continue;
    }
    if (
      name(base) !== group.basis.name.trim().toLowerCase() ||
      base.categoryId !== group.basis.categoryId
    ) {
      issues.push({ canonical, reason: 'Canonical no longer satisfies alias group basis' });
      continue;
    }
    const eligibleMembers: number[] = [];
    for (const hash of group.members) {
      if (hash === canonical) continue;
      if (generated[hash]) {
        issues.push({ canonical, member: hash, reason: 'Generated alias takes precedence' });
        continue;
      }
      const item = items[hash];
      if (
        !item ||
        (!inScope(item) && !exoticFrame) ||
        (exoticFrame
          ? item.categoryId !== 'weapon-frame-exotic' ||
            !numbered(item) ||
            frameOwner === undefined ||
            !owns(item, frameOwner) ||
            item.name
              .replace(/ (II|III|IV)$/, '')
              .trim()
              .toLowerCase() !== name(base)
          : name(item) !== name(base)) ||
        exotic(item) !== exotic(base) ||
        enhanced(item) !== enhanced(base) ||
        (group.kind === 'S' &&
          (item.categoryId !== base.categoryId ||
            (!subclass(base) &&
              (item.plugCategoryHash === undefined ||
                base.plugCategoryHash === undefined ||
                item.plugCategoryHash !== base.plugCategoryHash)))) ||
        (subclass(base) && item.inGameDescription !== base.inGameDescription)
      ) {
        issues.push({
          canonical,
          member: hash,
          reason: 'Member no longer satisfies alias group facts',
        });
        continue;
      }
      eligibleMembers.push(hash);
    }
    // Excluded members cannot invalidate surviving edges. Shared exotic traits still need
    // one proven owner common to the canonical and every otherwise eligible member.
    const sharedExoticOwner = [base.itemHash, ...(base.owners ?? [])].some(
      (owner) => owner !== undefined && eligibleMembers.every((hash) => owns(items[hash]!, owner)),
    );
    for (const hash of eligibleMembers) {
      if (exotic(base) && !exoticFrame && !sharedExoticOwner) {
        issues.push({
          canonical,
          member: hash,
          reason: 'Member no longer satisfies alias group facts',
        });
      } else {
        aliases[hash] = { to: canonical, kind: 'name' };
      }
    }
  }
  for (const key of Object.keys(aliases)) resolveAlias(Number(key), aliases);
  // Older catalogs can lack a pointer for an enhanced item with several base candidates.
  // Recover it only when every candidate belongs to one accepted base group.
  const pairedBase = (item: AliasItem | undefined) => {
    if (!item || !enhanced(item)) return item?.baseHash;
    if (item.baseHash !== undefined)
      return items[item.baseHash] && items[resolveAlias(item.baseHash, aliases)]
        ? item.baseHash
        : undefined;
    const candidates = Object.values(items).filter(
      (base) =>
        !enhanced(base) &&
        !exotic(base) &&
        inScope(base) &&
        name(base) === name(item) &&
        item.plugCategoryHash !== undefined &&
        base.plugCategoryHash === item.plugCategoryHash &&
        base.categoryId === item.categoryId.replace(/-enhanced$/, ''),
    );
    const targets = new Set(candidates.map((base) => resolveAlias(base.hash, aliases)));
    const target = [...targets][0];
    return candidates.length > 1 && targets.size === 1 && target !== undefined && items[target]
      ? target
      : undefined;
  };
  // Base-group drift can invalidate enhanced members even when their own facts still match.
  // Compare only active members, and repeat because removing an alias can expose another mismatch.
  let changed: boolean;
  do {
    changed = false;
    for (const [key, group] of Object.entries(groups.groups)) {
      const canonical = Number(key),
        item = items[key];
      if (!item || !enhanced(item) || generated[key]) continue;
      const canonicalBase = pairedBase(item);
      for (const member of group.members) {
        if (aliases[member]?.kind !== 'name' || aliases[member]?.to !== canonical) continue;
        const memberBase = pairedBase(items[member]);
        if (
          canonicalBase === undefined ||
          memberBase === undefined ||
          resolveAlias(memberBase, aliases) !== resolveAlias(canonicalBase, aliases)
        ) {
          delete aliases[member];
          issues.push({
            canonical,
            member,
            reason: 'Enhanced member no longer shares the canonical base group',
          });
          changed = true;
        }
      }
    }
  } while (changed);
  return { aliases, issues };
}

/** The only composition order: generated aliases, accepted name groups, then sandbox picks.
 * Validate picks against GENERATED aliases first, preserving existing inactive/undone behavior.
 * A previously valid pick follows its target through an accepted name group to canonical text.
 * A group may not turn a sandbox identity into a name alias: fail closed instead of dropping a
 * reviewed pick. All configs and facts must be read at the consumer's immutable source commit.
 */
export function composeAliases(
  generated: Aliases,
  groups: AliasGroups | null | undefined,
  items: AliasItems,
  conflicts: SandboxConflicts = {},
  pointers?: SandboxPointers | null,
): { aliases: Aliases; issues: AliasGroupIssue[] } {
  aliasesSchema.parse(generated);
  sandboxConflictsSchema.parse(conflicts);
  if (pointers != null) sandboxPointersSchema.parse(pointers);
  for (const key of Object.keys(generated)) resolveAlias(Number(key), generated);
  const picked = mergeSandboxPointers(generated, conflicts, pointers);
  if (groups == null) return { aliases: picked, issues: [] };
  const result = effectiveAliases(generated, groups, items);
  const aliases: Aliases = { ...result.aliases };
  for (const [hash, alias] of Object.entries(result.aliases)) {
    if (Object.hasOwn(generated, hash)) continue;
    if (
      alias.kind === 'name' &&
      (Object.hasOwn(conflicts, hash) || Object.hasOwn(conflicts, String(alias.to)))
    )
      throw new Error(`Alias group member ${hash} is a shared sandbox identity`);
  }
  for (const [hash, alias] of Object.entries(picked)) {
    if (Object.hasOwn(generated, hash)) continue;
    aliases[hash] = { ...alias, to: resolveAlias(alias.to, result.aliases) };
  }
  for (const key of Object.keys(aliases)) resolveAlias(Number(key), aliases);
  return { aliases, issues: result.issues };
}

/** Identities whose tooltip or incoming stubs can change, including old and new canonicals.
 * Consumers reload/review these identities even when grouping leaves no outgoing edge behind.
 */
export function affectedAliasCanonicals(
  before: Aliases,
  after: Aliases,
  items: AliasItems,
): number[] {
  const affected = new Set<number>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[key],
      next = after[key];
    if (
      old?.to === next?.to &&
      old?.kind === next?.kind &&
      resolveAlias(Number(key), before) === resolveAlias(Number(key), after)
    )
      continue;
    affected.add(aliasCanonicalHash(Number(key), items, before));
    affected.add(aliasCanonicalHash(Number(key), items, after));
  }
  return [...affected].sort((a, b) => a - b);
}

/** Alias -> enhanced canonical -> base -> base canonical, preserving frame editor ownership. */
export function aliasCanonicalHash(hash: number, items: AliasItems, aliases: Aliases): number {
  const seen = new Set<number>();
  while (!seen.has(hash)) {
    seen.add(hash);
    const resolved = resolveAlias(hash, aliases);
    if (resolved !== hash) {
      hash = resolved;
      continue;
    }
    if (
      Object.values(aliases).some((a) => a.kind === 'frame' && resolveAlias(a.to, aliases) === hash)
    )
      return hash;
    const item = items[hash];
    const base = item?.baseHash;
    if (base === undefined || (item && exotic(item))) return hash;
    hash = base;
  }
  throw new Error(`Cyclic tooltip pairing at ${hash}`);
}
export function aliasVariantHashes(hash: number, items: AliasItems, aliases: Aliases): number[] {
  const base = aliasCanonicalHash(hash, items, aliases);
  return [
    base,
    ...Object.values(items)
      .filter(
        (i) =>
          i.hash !== base &&
          resolveAlias(i.hash, aliases) === i.hash &&
          aliasCanonicalHash(i.hash, items, aliases) === base,
      )
      .map((i) => i.hash)
      .sort((a, b) => a - b),
  ];
}

export const aliasProposalSchema = z
  .object({
    kind: z.enum(['S', 'X']),
    canonical: hashSchema,
    members: z
      .array(hashSchema)
      .min(2)
      .refine((v) => new Set(v).size === v.length),
    basis: z
      .object({
        name: z.string(),
        categoryId: z.string(),
        isEnhanced: z.boolean(),
        exotic: z.boolean(),
        plugCategoryHash: hashSchema.optional(),
        exoticFrameOwner: hashSchema.optional(),
      })
      .strict(),
    descriptionDiff: z.enum(['identical', 'wording', 'numbers']),
    statsDiff: z.boolean(),
    enhancedLink: hashSchema.optional(),
    weapons: z.record(hashKey, z.array(z.object({ hash: hashSchema, name: z.string() }).strict())),
  })
  .strict();
export const aliasProposalsSchema = z
  .object({
    version: z.literal(1),
    proposals: z.array(aliasProposalSchema),
    possibleEnhanced: z
      .array(
        z
          .object({
            baseHash: hashSchema,
            variantHash: hashSchema,
            reason: z.literal('possible enhanced — maintainer call'),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type AliasProposal = z.infer<typeof aliasProposalSchema>;
/** Unlabelled DIM pairs stay outside the alias queue until a maintainer determines their meaning. */
export function readPossibleEnhanced(input: unknown) {
  return aliasProposalsSchema.parse(input).possibleEnhanced;
}
/** Reader enrichment uses editor data only; the generator never selects text. */
export function readAliasProposals(input: unknown, tooltips: Readonly<Record<string, Tooltip>>) {
  return aliasProposalsSchema.parse(input).proposals.map((proposal) => {
    const inGroupImport = new RegExp(`^import main from (${proposal.members.join('|')})\\s*$`);
    const texts = proposal.members.map((h) =>
      Object.fromEntries(
        Object.entries(tooltips[h]?.text ?? {}).filter(
          ([, value]) => !inGroupImport.test(value.text.trim()),
        ),
      ),
    );
    const conflicts =
      new Set(texts.flatMap((t) => Object.keys(t))).size > 0 &&
      [...new Set(texts.flatMap((t) => Object.keys(t)))].some(
        (lang) =>
          new Set(texts.map((t) => t[lang as keyof typeof t]?.text.trim()).filter(Boolean)).size >
          1,
      );
    const own = proposal.members.filter((h) =>
      Object.values(tooltips[h]?.text ?? {}).some(
        (t) => t?.text.trim() && !inGroupImport.test(t.text.trim()),
      ),
    );
    const canonical =
      proposal.basis.exoticFrameOwner === undefined && own.length === 1
        ? own[0]!
        : proposal.canonical;
    const enhancedMarkup = Object.values(tooltips[canonical]?.text ?? {}).some((t) =>
      /enhanced\s*\(|#e\b|<enhanced\/>/.test(t?.text ?? ''),
    );
    return {
      ...proposal,
      canonical,
      textState: conflicts ? 'conflict' : own.length ? 'one text' : 'all empty',
      action: proposal.kind === 'X' && enhancedMarkup ? 'derive' : 'alias',
      bulkEligible: proposal.kind === 'S' && proposal.descriptionDiff === 'identical' && !conflicts,
    };
  });
}

/** Real enhanced pairs with different manifest wording and no enhanced English section. */
export function enhancedWordingNeeded(
  items: AliasItems,
  aliases: Aliases,
  tooltips: Readonly<Record<string, Tooltip>>,
) {
  const result = new Map<number, { baseHash: number; enhancedHashes: number[] }>();
  for (const item of Object.values(items)) {
    // Enhanced parts and paired mods are edited with their base.
    if (
      !enhanced(item) ||
      item.baseHash === undefined ||
      item.categoryId === 'weapon-perk-enhanced' ||
      isPairedEnhancedMod(item)
    )
      continue;
    const base = items[item.baseHash];
    if (!base || item.inGameDescription === base.inGameDescription) continue;
    const baseHash = aliasCanonicalHash(item.hash, items, aliases);
    if (/enhanced\s*\(|#e\b|<enhanced\/>/.test(tooltips[baseHash]?.text.en?.text ?? '')) continue;
    const row = result.get(baseHash) ?? { baseHash, enhancedHashes: [] };
    const target = resolveAlias(item.hash, aliases);
    if (!row.enhancedHashes.includes(target)) row.enhancedHashes.push(target);
    result.set(baseHash, row);
  }
  return [...result.values()]
    .sort((a, b) => a.baseHash - b.baseHash)
    .map((row) => ({ ...row, enhancedHashes: row.enhancedHashes.sort((a, b) => a - b) }));
}
