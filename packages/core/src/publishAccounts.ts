import { z } from 'zod';
import { hashSchema } from './legacy.js';
import { publishOpIdSchema } from './publishRequest.js';

/**
 * PIN capability of a publisher build that drains `selection: 'whole'` publish requests: it runs
 * every row check the Worker skips for them, holds the rows that fail with what depends on them,
 * publishes the rest as one publication, and keeps the account publish index.
 */
export const wholeSelectionCapability = 'wholeSelectionV1';

/** Why the publisher held a row of a whole-selection publish (the rest went live). */
export const heldRowSchema = z
  .object({
    hash: hashSchema,
    /** changed: the saved text differs from what was reviewed (or is gone); activation: a
     * scheduled batch activation conflict waits; refused: a row check refused it; dependency: it
     * publishes together with held row `on`. */
    code: z.enum(['changed', 'activation', 'refused', 'dependency']),
    reason: z.string().min(1).max(1000),
    on: hashSchema.optional(),
  })
  .strict();
export type HeldRow = z.infer<typeof heldRowSchema>;

/**
 * The account publish index, `publish/accounts/<GitHub id>.json` on the data branch: the last
 * whole-selection publishes of one account and their outcomes, for any device of that account.
 * Counts and statuses only, never tooltip text; the Worker writes an entry in the same commit as
 * the request, the publisher updates it in its RECORD commit.
 */
export const publishAccountPath = (id: number) => `publish/accounts/${id}.json`;
export const publishAccountLimit = 50;
export const publishAccountStatuses = [
  'pending',
  'done',
  'unchanged',
  'stale',
  'rejected',
] as const;
const entrySchema = z
  .object({
    opId: publishOpIdSchema,
    createdAt: z.string().datetime(),
    rows: z.number().int().nonnegative(),
    globals: z.number().int().nonnegative(),
    status: z.enum(publishAccountStatuses),
    held: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PublishAccountEntry = z.infer<typeof entrySchema>;
export const publishAccountSchema = z
  .object({ entries: z.array(entrySchema).max(publishAccountLimit) })
  .strict();
export type PublishAccount = z.infer<typeof publishAccountSchema>;

/** A stored index, or an empty one; an unreadable file is replaced rather than blocking a publish. */
export function readPublishAccount(raw: unknown): PublishAccount {
  return publishAccountSchema.safeParse(raw).data ?? { entries: [] };
}

/** Add (or replace) one entry, newest last, keeping the newest `publishAccountLimit`. */
export function admitToPublishAccount(raw: unknown, entry: PublishAccountEntry): PublishAccount {
  const entries = readPublishAccount(raw).entries.filter(({ opId }) => opId !== entry.opId);
  entries.push(entry);
  return { entries: entries.slice(-publishAccountLimit) };
}

/** The outcome of one listed publish; undefined when the index does not list it. */
export function recordInPublishAccount(
  raw: unknown,
  opId: string,
  outcome: Pick<PublishAccountEntry, 'status' | 'held' | 'updatedAt'>,
): PublishAccount | undefined {
  const index = readPublishAccount(raw);
  const at = index.entries.findIndex((entry) => entry.opId === opId);
  if (at < 0) return undefined;
  const entries = [...index.entries];
  entries[at] = { ...entries[at]!, ...outcome };
  return { entries };
}
