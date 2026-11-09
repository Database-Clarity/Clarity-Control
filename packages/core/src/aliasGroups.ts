import { z } from 'zod';
import { hashSchema } from './legacy.js';
import { aliasesSchema, resolveAlias, type Aliases } from './aliases.js';
import { timestampSchema, type Tooltip } from './schemas.js';

const hashKey = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => Number(v) <= 0xffffffff);
const actor = z.object({ id: z.string().min(1), login: z.string().min(1) }).strict();
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
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
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
const enhanced = (item: AliasItem) =>
  !exotic(item) && (item.isEnhanced ?? item.categoryId.includes('-enhanced'));
const exotic = (item: AliasItem) => item.exotic ?? item.categoryId.endsWith('-exotic');
const name = (item: AliasItem) => item.name.trim().toLowerCase();
const inScope = (item: AliasItem) =>
  /^(weapon-(perk|trait|mod)|armor-mod|subclass)-?/.test(item.categoryId);
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
  issues: { canonical: number; member?: number; reason: string }[];
} {
  const groups = aliasGroupsSchema.parse(input);
  const aliases: Aliases = { ...aliasesSchema.parse(generated) };
  const issues: { canonical: number; member?: number; reason: string }[] = [];
  for (const [key, group] of Object.entries(groups.groups)) {
    const canonical = Number(key),
      base = items[key];
    const frameOwner = group.basis.exoticFrameOwner;
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
            (!base.categoryId.startsWith('subclass-') &&
              (item.plugCategoryHash === undefined ||
                base.plugCategoryHash === undefined ||
                item.plugCategoryHash !== base.plugCategoryHash)))) ||
        (group.kind === 'X' &&
          (enhanced(item) ||
            enhanced(base) ||
            exotic(item) ||
            exotic(base) ||
            item.inGameDescription !== base.inGameDescription ||
            !(item.dimBaseHash === canonical || base.dimBaseHash === hash))) ||
        (base.categoryId.startsWith('subclass-') &&
          item.inGameDescription !== base.inGameDescription)
      ) {
        issues.push({
          canonical,
          member: hash,
          reason: 'Member no longer satisfies alias group facts',
        });
        continue;
      }
      aliases[hash] = { to: canonical, kind: 'name' };
    }
  }
  for (const key of Object.keys(aliases)) resolveAlias(Number(key), aliases);
  // Older catalogs can lack a pointer for an enhanced item with several base candidates.
  // Recover it only when every candidate belongs to one accepted base group.
  const pairedBase = (item: AliasItem | undefined) => {
    if (!item || !enhanced(item)) return item?.baseHash;
    if (item.baseHash !== undefined) return item.baseHash;
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
    return candidates.length > 1 && targets.size === 1 ? [...targets][0] : undefined;
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
      /enhanced\s*\(|#e\b/.test(t?.text ?? ''),
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
    // Enhanced weapon parts never need wording of their own (owner 2026-11-09).
    if (
      !enhanced(item) ||
      item.baseHash === undefined ||
      item.categoryId === 'weapon-perk-enhanced'
    )
      continue;
    const base = items[item.baseHash];
    if (!base || item.inGameDescription === base.inGameDescription) continue;
    const baseHash = aliasCanonicalHash(item.hash, items, aliases);
    if (/enhanced\s*\(|#e\b/.test(tooltips[baseHash]?.text.en?.text ?? '')) continue;
    const row = result.get(baseHash) ?? { baseHash, enhancedHashes: [] };
    const target = resolveAlias(item.hash, aliases);
    if (!row.enhancedHashes.includes(target)) row.enhancedHashes.push(target);
    result.set(baseHash, row);
  }
  return [...result.values()]
    .sort((a, b) => a.baseHash - b.baseHash)
    .map((row) => ({ ...row, enhancedHashes: row.enhancedHashes.sort((a, b) => a - b) }));
}
