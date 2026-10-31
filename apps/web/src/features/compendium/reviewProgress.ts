import { z } from 'zod';

const decisionSchema = z.object({
  kind: z.enum(['open', 'skipped', 'no-equivalent']),
  fingerprint: z.string(),
});
export const progressSchema = z.object({
  version: z.literal(1),
  selected: z.number().optional(),
  query: z.string(),
  category: z.string(),
  filter: z.enum(['open', 'all', 'drafted', 'saved', 'skipped', 'no-equivalent']),
  decisions: z.record(z.string(), decisionSchema),
});
export type ReviewProgress = z.infer<typeof progressSchema>;
export const emptyProgress = (): ReviewProgress => ({
  version: 1,
  query: '',
  category: '',
  filter: 'open',
  decisions: {},
});
export function reviewStorageKey(dataScope: string, userId?: string | number): string {
  return `clarity-compendium-review:v1:${encodeURIComponent(dataScope)}:${
    userId === undefined ? 'anonymous' : `user-${encodeURIComponent(String(userId))}`
  }`;
}
export function readProgress(storage: Pick<Storage, 'getItem'>, key: string): ReviewProgress {
  const raw = storage.getItem(key);
  if (!raw) return emptyProgress();
  const result = progressSchema.safeParse(JSON.parse(raw));
  if (!result.success) throw new Error('Stored review progress is invalid; using an empty queue.');
  return result.data;
}
// Change detection only, not an identity or security hash. Fetch timestamps are excluded.
export function sourceFingerprint(value: unknown): string {
  // Schema parsing can reorder run properties without changing their content.
  const text = JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
export function localDecision(progress: ReviewProgress, hash: number, fingerprint: string) {
  const decision = progress.decisions[hash];
  return decision?.fingerprint === fingerprint ? decision.kind : 'open';
}
