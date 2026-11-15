import { z } from 'zod';
import {
  aliasesSchema,
  hashSchema,
  type Aliases,
  type AliasItems,
  type LegacyCatalog,
} from '@clarity/core';
import type { GitHub } from './github.js';
import { HttpError, upstreamJson } from './http.js';
import type { Env } from './types.js';

const itemSchema = z.object({
  hash: hashSchema,
  name: z.string(),
  categoryId: z.string(),
  inGameDescription: z.string().optional(),
  isEnhanced: z.boolean().optional(),
  exotic: z.boolean().optional(),
  plugCategoryHash: hashSchema.optional(),
  baseHash: hashSchema.optional(),
  dimBaseHash: hashSchema.optional(),
  itemHash: hashSchema.optional(),
  itemName: z.string().optional(),
  // Editor-only; accepted so the generator may emit it, never exported.
  owners: z.array(hashSchema).optional(),
});
const itemsSchema = z.record(z.string(), itemSchema);
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
      .then((value) =>
        revision
          ? z.record(z.string(), itemSchema.extend({ inGameDescription: z.string() })).parse(value)
          : itemsSchema.parse(value),
      ),
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
    items: Object.fromEntries(
      Object.entries(items).map(([key, item]) => [
        key,
        {
          ...item,
          inGameDescription: item.inGameDescription ?? '',
        },
      ]),
    ),
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
