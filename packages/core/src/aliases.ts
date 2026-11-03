import { z } from 'zod';
import { hashSchema } from './legacy.js';

export const aliasesSchema = z.record(
  z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .refine((value) => Number(value) <= 0xffffffff),
  z.object({ to: hashSchema, kind: z.enum(['sandbox', 'frame', 'name']) }).strict(),
);
export type Aliases = z.infer<typeof aliasesSchema>;

export function resolveAlias(hash: number, aliases: Aliases): number {
  const seen = new Set<number>();
  while (aliases[hash]) {
    if (seen.has(hash)) throw new Error(`Cyclic tooltip alias at ${hash}`);
    seen.add(hash);
    hash = aliases[hash].to;
  }
  return hash;
}

type IncomingAlias = [number, 'sandbox' | 'frame' | 'name'];
const incomingIndexes = new WeakMap<Aliases, Map<number, IncomingAlias[]>>();

/**
 * The aliases that resolve to `hash`, sorted by hash: what an export of `hash` also writes as stubs.
 * The index over all aliases is built once per alias object, so digesting thousands of tooltips
 * stays linear. Treat an `Aliases` object as immutable once passed here.
 */
export function incomingAliases(hash: number, aliases: Aliases): IncomingAlias[] {
  let index = incomingIndexes.get(aliases);
  if (!index) {
    index = new Map();
    for (const [alias, { kind }] of Object.entries(aliases)) {
      const target = resolveAlias(Number(alias), aliases);
      const list = index.get(target);
      if (list) list.push([Number(alias), kind]);
      else index.set(target, [[Number(alias), kind]]);
    }
    for (const list of index.values()) list.sort((x, y) => x[0] - y[0]);
    incomingIndexes.set(aliases, index);
  }
  return index.get(hash) ?? [];
}
