import { z } from 'zod';
import { aliasesSchema, hashSchema, type Aliases, type LegacyCatalog } from '@clarity/core';
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
const categoriesSchema = z.array(
  z.object({
    id: z.string(),
    legacyType: z.string().optional(),
  }),
);
function source(env: Env): string {
  return (
    `https://raw.githubusercontent.com/${encodeURIComponent(env.GENERATOR_OWNER)}/` +
    `${encodeURIComponent(env.GENERATOR_REPO)}/${encodeURIComponent(env.GENERATOR_BRANCH)}/templates/v2`
  );
}

export async function loadAliases(env: Env): Promise<Aliases> {
  return fetch(`${source(env)}/aliases.json`)
    .then(upstreamJson)
    .then((value) => aliasesSchema.parse(value));
}

export async function catalog(env: Env): Promise<{
  facts: LegacyCatalog;
  aliases: Aliases;
}> {
  const root = source(env);
  const [items, categories, aliases] = await Promise.all([
    fetch(`${root}/items.json`)
      .then(upstreamJson)
      .then((value) => itemsSchema.parse(value)),
    fetch(`${root}/categories.json`)
      .then(upstreamJson)
      .then((value) => categoriesSchema.parse(value)),
    loadAliases(env),
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
  return { facts, aliases };
}
