import { z } from 'zod';
import {
  aliasesSchema,
  composeAliases,
  hashSchema,
  type Aliases,
  type AliasItems,
  type AliasGroups,
  type LegacyCatalog,
  type SandboxConflicts,
  type SandboxPointers,
} from '@clarity/core';
import type { GitHub } from './github.js';
import { HttpError, upstreamJson } from './http.js';
import type { Env } from './types.js';

const itemSchema = z.object({
  hash: hashSchema,
  name: z.string(),
  categoryId: z.string(),
  itemHash: hashSchema.optional(),
  itemName: z.string().optional(),
  // Editor-only; accepted so the generator may emit it, never exported.
  owners: z.array(hashSchema).optional(),
});
const itemsSchema = z.record(z.string(), itemSchema);
const aliasItemSchema = itemSchema.extend({
  inGameDescription: z.string(),
  isEnhanced: z.boolean().optional(),
  exotic: z.boolean().optional(),
  plugCategoryHash: hashSchema.optional(),
  baseHash: hashSchema.optional(),
  dimBaseHash: hashSchema.optional(),
});
const aliasItemsSchema = z.record(z.string(), aliasItemSchema);
const categoriesSchema = z.array(
  z.object({
    id: z.string(),
    legacyType: z.string().optional(),
  }),
);
export function source(env: Env, revision = env.GENERATOR_BRANCH): string {
  return (
    `https://raw.githubusercontent.com/${encodeURIComponent(env.GENERATOR_OWNER)}/` +
    `${encodeURIComponent(env.GENERATOR_REPO)}/${encodeURIComponent(revision)}/templates/v2`
  );
}

/** `budget` counts the subrequest against the operation's limit (see GitHub.spend). */
export async function loadAliases(
  env: Env,
  budget?: Pick<GitHub, 'spend'>,
  revision?: string,
): Promise<Aliases> {
  budget?.spend();
  return fetch(`${source(env, revision)}/aliases.json`)
    .then(upstreamJson)
    .then((value) => aliasesSchema.parse(value));
}

export async function catalog(
  env: Env,
  budget?: Pick<GitHub, 'spend'>,
  revision?: string,
): Promise<{
  facts: LegacyCatalog;
  aliases: Aliases;
  items: AliasItems;
}> {
  budget?.spend(2); // items and categories; aliases are counted by loadAliases
  const root = source(env, revision);
  const [items, categories, aliases] = await Promise.all([
    fetch(`${root}/items.json`)
      .then(upstreamJson)
      .then((value) => (revision ? aliasItemsSchema.parse(value) : itemsSchema.parse(value))),
    fetch(`${root}/categories.json`)
      .then(upstreamJson)
      .then((value) => categoriesSchema.parse(value)),
    loadAliases(env, budget, revision),
  ]);
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const facts: LegacyCatalog = {};
  for (const [hash, item] of Object.entries(items)) {
    if (Number(hash) !== item.hash) throw new HttpError(502, 'Generator item hash mismatch');
    const category = categoriesById.get(item.categoryId);
    if (!category) throw new HttpError(502, `Generator category is missing: ${item.categoryId}`);
    facts[hash] = {
      name: item.name,
      type: category.legacyType ?? category.id,
      ...(item.itemHash === undefined ? {} : { itemHash: item.itemHash }),
      ...(item.itemName === undefined ? {} : { itemName: item.itemName }),
    };
  }
  return {
    facts,
    aliases,
    // The legacy path needs only export facts. Do not validate or reconstruct group facts
    // unless a pinned grouping consumer explicitly requested them above.
    items: revision ? (items as AliasItems) : {},
  };
}

/** Pin ALL grouping inputs once, so a generator branch move cannot mix facts and aliases. */
export async function aliasCatalog(github: GitHub) {
  const env = github.env;
  github.spend();
  const { sha } = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }).parse(
    await fetch(
      `https://api.github.com/repos/${encodeURIComponent(env.GENERATOR_OWNER)}/${encodeURIComponent(env.GENERATOR_REPO)}/commits/${encodeURIComponent(env.GENERATOR_BRANCH)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Clarity-Editor' },
      },
    ).then(upstreamJson),
  );
  return { ...(await catalog(env, github, sha)), revision: sha };
}

/** Raw pinned files are narrowed BEFORE schema validation; S1 still decides every alias edge. */
export async function aliasInputs(github: GitHub, includeCategories = false) {
  github.spend();
  const env = github.env;
  const { sha } = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }).parse(
    await fetch(
      `https://api.github.com/repos/${encodeURIComponent(env.GENERATOR_OWNER)}/${encodeURIComponent(env.GENERATOR_REPO)}/commits/${encodeURIComponent(env.GENERATOR_BRANCH)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Clarity-Editor' },
      },
    ).then(upstreamJson),
  );
  const read = async (file: string) => {
    github.spend();
    return fetch(`${source(env, sha)}/${file}`).then(upstreamJson);
  };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new HttpError(502, 'Invalid upstream alias input');
    return value as Record<string, unknown>;
  };
  const [items, aliases, conflicts, categories] = await Promise.all([
    read('items.json').then(record),
    read('aliases.json').then(record),
    read('sandboxConflicts.json').then(record),
    includeCategories ? read('categories.json').then((value) => categoriesSchema.parse(value)) : [],
  ]);
  return { items, aliases, conflicts, categories, revision: sha };
}

export interface AliasScope {
  aliases: Aliases;
  facts: LegacyCatalog;
  extend(hashes: readonly number[]): Aliases;
}

/** Request-local reachability only. Group membership, generated edges, and fact candidates
 * select S1's inputs; this does not infer or resolve an alias. Both edge directions retain all
 * incoming stubs for review hashes. Base/name candidates retain S1's enhanced pairing checks.
 */
export function scopedAliases(
  input: Pick<
    Awaited<ReturnType<typeof aliasInputs>>,
    'items' | 'aliases' | 'conflicts' | 'categories'
  >,
  groups: AliasGroups,
  pointers: SandboxPointers | null,
): AliasScope {
  const edges = new Map<number, number[]>();
  const connect = (a: number, b: number) => {
    const add = (from: number, to: number) => {
      const list = edges.get(from);
      if (list) list.push(to);
      else edges.set(from, [to]);
    };
    add(a, b);
    add(b, a);
  };
  for (const [key, raw] of Object.entries(input.aliases)) {
    const to = (raw as { to?: unknown } | null)?.to;
    if (typeof to !== 'number') throw new HttpError(502, 'Invalid generator alias target');
    connect(Number(key), to);
  }
  const membership = new Map<number, string>();
  for (const [key, group] of Object.entries(groups.groups))
    for (const hash of group.members) {
      membership.set(hash, key);
      connect(Number(key), hash);
    }
  for (const [key, pointer] of Object.entries(pointers?.pointers ?? {}))
    if ('to' in pointer) connect(Number(key), pointer.to);
  // Include every potential pairing fact with the same name and plug identity. S1 alone
  // filters category/flags and decides whether ambiguous bases become one accepted group.
  const candidates = new Map<string, number[]>();
  const names = new Map<number, string>();
  for (const [key, raw] of Object.entries(input.items)) {
    const item = raw as Partial<AliasItems[string]> | null;
    if (!item || typeof item !== 'object') continue;
    if (typeof item.name === 'string' && typeof item.plugCategoryHash === 'number') {
      const name = JSON.stringify([item.name.trim().toLowerCase(), item.plugCategoryHash]);
      names.set(Number(key), name);
      const list = candidates.get(name);
      if (list) list.push(Number(key));
      else candidates.set(name, [Number(key)]);
    }
  }
  const wanted = new Set<number>();
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const scope: AliasScope = {
    aliases: {},
    facts: {},
    extend(hashes) {
      if (hashes.every((hash) => wanted.has(hash))) return scope.aliases;
      const pending = [...hashes];
      while (pending.length) {
        const hash = pending.pop()!;
        if (wanted.has(hash)) continue;
        wanted.add(hash);
        pending.push(...(edges.get(hash) ?? []));
        const raw = input.items[hash] as Partial<AliasItems[string]> | undefined;
        if (raw?.baseHash !== undefined) pending.push(raw.baseHash);
        // Only group members need pairing candidates; unrelated same-name entries do not
        // expand a request unless they can affect an accepted group's enhanced validity.
        const name = names.get(hash);
        if (membership.has(hash) && name) pending.push(...(candidates.get(name) ?? []));
      }
      const selectedItems: Record<string, AliasItems[string]> = {};
      const selectedAliases: Aliases = {};
      for (const hash of wanted) {
        if (Object.hasOwn(input.items, String(hash))) {
          const item = aliasItemSchema.parse(input.items[hash]);
          if (item.hash !== hash) throw new HttpError(502, 'Generator item hash mismatch');
          selectedItems[hash] = item;
          if (input.categories.length) {
            const category = categories.get(item.categoryId);
            if (!category)
              throw new HttpError(502, `Generator category is missing: ${item.categoryId}`);
            scope.facts[hash] = {
              name: item.name,
              type: category.legacyType ?? category.id,
              ...(item.itemHash === undefined ? {} : { itemHash: item.itemHash }),
              ...(item.itemName === undefined ? {} : { itemName: item.itemName }),
            };
          }
        }
        if (Object.hasOwn(input.aliases, String(hash)))
          selectedAliases[hash] = input.aliases[hash] as Aliases[string];
      }
      const selectedGroups: AliasGroups = {
        version: 1,
        rejected: {},
        groups: Object.fromEntries(
          Object.entries(groups.groups).filter(([key]) => wanted.has(Number(key))),
        ),
      };
      const selectedPointers = pointers
        ? {
            version: 1 as const,
            pointers: Object.fromEntries(
              Object.entries(pointers.pointers).filter(([key]) => wanted.has(Number(key))),
            ),
          }
        : null;
      scope.aliases = composeAliases(
        selectedAliases,
        selectedGroups,
        selectedItems,
        input.conflicts as SandboxConflicts,
        selectedPointers,
      ).aliases;
      return scope.aliases;
    },
  };
  return scope;
}
