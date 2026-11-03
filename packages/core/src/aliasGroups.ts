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
          basis: z.object({ name: z.string(), categoryId: z.string() }).strict(),
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
}
export type AliasItems = Readonly<Record<string, AliasItem>>;
const enhanced = (item: AliasItem) => item.isEnhanced ?? item.categoryId.includes('-enhanced');
const exotic = (item: AliasItem) => item.exotic ?? item.categoryId.endsWith('-exotic');
const name = (item: AliasItem) => item.name.trim().toLowerCase();
const inScope = (item: AliasItem) =>
  /^(weapon-(perk|trait|mod)|armor-mod|subclass)-?/.test(item.categoryId);

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
    if (!base || !inScope(base) || generated[key]) {
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
        !inScope(item) ||
        name(item) !== name(base) ||
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
            !(item.baseHash === canonical || base.baseHash === hash))) ||
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
  // Base-group drift can invalidate enhanced members even when their own facts still match.
  // Compare only active members, and repeat because removing an alias can expose another mismatch.
  let changed: boolean;
  do {
    changed = false;
    for (const [key, group] of Object.entries(groups.groups)) {
      const canonical = Number(key),
        item = items[key];
      if (!item || !enhanced(item) || generated[key]) continue;
      const canonicalBase = item.baseHash;
      for (const member of group.members) {
        if (aliases[member]?.kind !== 'name' || aliases[member]?.to !== canonical) continue;
        const memberBase = items[member]?.baseHash;
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
    const base = items[hash]?.baseHash;
    if (base === undefined) return hash;
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
  })
  .strict();
export type AliasProposal = z.infer<typeof aliasProposalSchema>;
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
    const canonical = own.length === 1 ? own[0]! : proposal.canonical;
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
    if (!enhanced(item) || item.baseHash === undefined) continue;
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
