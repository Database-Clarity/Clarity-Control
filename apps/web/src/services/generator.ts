import { z } from 'zod';
import { aliasesSchema, sandboxConflictsFile, sandboxConflictsSchema } from '@clarity/core';
import { fetchJson } from './http';

const source =
  'https://raw.githubusercontent.com/Database-Clarity/Description-data-generator/v2/templates/v2';

export {
  categorySchema,
  itemSchema,
  itemsSchema,
  type Category,
  type Item,
} from './generatorSchema';
import { categorySchema, itemsSchema } from './generatorSchema';
import { presentCategories } from './categoryLabels';

export async function loadGenerator(signal?: AbortSignal) {
  const [categories, items, aliases] = await Promise.all([
    fetchJson(`${source}/categories.json`, z.array(categorySchema), { signal }),
    fetchJson(`${source}/items.json`, itemsSchema, { signal }),
    fetchJson(`${source}/aliases.json`, aliasesSchema, { signal }),
  ]);
  return {
    categories: presentCategories(categories),
    items,
    aliases,
  };
}

/**
 * The generator's shared sandbox perks (hash -> tooltip identities sharing it). Needed to apply
 * maintainer picks (core mergeSandboxPointers) and by the Sandbox perks worklist.
 */
export function loadSandboxConflicts(signal?: AbortSignal) {
  return fetchJson(`${source}/${sandboxConflictsFile}`, sandboxConflictsSchema, { signal });
}
