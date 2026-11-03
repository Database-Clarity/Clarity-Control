import { z } from 'zod';
import { hashSchema } from './legacy.js';

export const aliasesSchema = z.record(
  z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .refine((value) => Number(value) <= 0xffffffff),
  z.object({ to: hashSchema, kind: z.enum(['sandbox', 'frame']) }).strict(),
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

/** The aliases that resolve to `hash`, sorted by hash: what an export of `hash` also writes as stubs. */
export function incomingAliases(hash: number, aliases: Aliases): [number, 'sandbox' | 'frame'][] {
  return Object.entries(aliases)
    .filter(([alias]) => resolveAlias(Number(alias), aliases) === hash)
    .map(([alias, { kind }]): [number, 'sandbox' | 'frame'] => [Number(alias), kind])
    .sort((a, b) => a[0] - b[0]);
}
