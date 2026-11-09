import { type Drafts } from '../../services/draftStorage';
import { unownedBucket, type Snapshot } from './snapshot';

export interface BucketPlan {
  /** Drafts the target bucket does not have: added as they are. */
  added: string[];
  /** Already there with identical content: nothing to do. */
  identical: string[];
  /** The target has a DIFFERENT draft for the same tooltip: the target's is kept untouched. */
  conflicts: string[];
}

/** Pure per-tooltip merge: existing drafts are never replaced. */
export function planBucket(existing: Drafts, incoming: Drafts): BucketPlan {
  const plan: BucketPlan = { added: [], identical: [], conflicts: [] };
  for (const [hash, draft] of Object.entries(incoming)) {
    const current = existing[hash];
    if (!current) plan.added.push(hash);
    else if (JSON.stringify(current) === JSON.stringify(draft)) plan.identical.push(hash);
    else plan.conflicts.push(hash);
  }
  return plan;
}

export interface MergeOutcome {
  /** Buckets whose stored content changes, with their full new content. */
  writes: Record<string, Drafts>;
  /** Per bucket, the hashes now safely held on this side with the sent content. */
  stored: Record<string, string[]>;
  added: number;
  identical: number;
  /** Conflicts parked in the signed-out bucket, where the adopt / keep-separate flow handles them. */
  keptSeparate: number;
  /** Conflicts with nowhere safe to go: offered as a file, and left untouched at the source. */
  unplaced: Snapshot['buckets'];
}

/**
 * Merges a whole snapshot into the current buckets. A conflicting account draft goes to the
 * signed-out bucket when that slot is free (or already identical); anything else is `unplaced`.
 * Pure: reads `current`, never mutates it, and never produces a write that replaces a draft.
 */
export function mergeSnapshot(current: Record<string, Drafts>, snapshot: Snapshot): MergeOutcome {
  const writes: Record<string, Drafts> = {};
  const stored: Record<string, string[]> = {};
  const unplaced: Snapshot['buckets'] = {};
  let added = 0;
  let identical = 0;
  let keptSeparate = 0;
  const base = (bucket: string): Drafts => writes[bucket] ?? current[bucket] ?? {};
  const keep = (bucket: string, hash: string) => (stored[bucket] ??= []).push(hash);
  const sorted = Object.entries(snapshot.buckets).sort(([a], [b]) =>
    a === unownedBucket ? -1 : b === unownedBucket ? 1 : a.localeCompare(b),
  );
  for (const [bucket, incoming] of sorted) {
    const plan = planBucket(current[bucket] ?? {}, incoming);
    if (plan.added.length) {
      writes[bucket] = {
        ...base(bucket),
        ...Object.fromEntries(plan.added.map((h) => [h, incoming[h]!])),
      };
      added += plan.added.length;
      plan.added.forEach((hash) => keep(bucket, hash));
    }
    identical += plan.identical.length;
    plan.identical.forEach((hash) => keep(bucket, hash));
    for (const hash of plan.conflicts) {
      const draft = incoming[hash]!;
      const parked = bucket === unownedBucket ? undefined : base(unownedBucket)[hash];
      if (bucket !== unownedBucket && !parked) {
        writes[unownedBucket] = { ...base(unownedBucket), [hash]: draft };
        keptSeparate++;
        keep(bucket, hash);
      } else if (bucket !== unownedBucket && JSON.stringify(parked) === JSON.stringify(draft)) {
        keep(bucket, hash);
      } else {
        (unplaced[bucket] ??= {})[hash] = draft;
      }
    }
  }
  return { writes, stored, added, identical, keptSeparate, unplaced };
}

/** Preferences are added only where this browser has no value yet; an existing value always wins. */
export function mergePrefs(
  existing: (key: string) => string | null,
  incoming: Snapshot['prefs'],
): { writes: Record<string, string>; skipped: number } {
  const writes: Record<string, string> = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(incoming)) {
    if (existing(key) === null) writes[key] = value;
    else skipped++;
  }
  return { writes, skipped };
}
