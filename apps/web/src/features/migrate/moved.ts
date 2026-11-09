import { draftCount } from './snapshot';
import type { Collected } from './storage';

export type MovedStart =
  { kind: 'redirect' } | { kind: 'idle'; drafts: number } | { kind: 'unreadable' };

/**
 * What the moved page does first. It leaves for the new site on its own ONLY when there is
 * nothing here to lose: no readable drafts AND nothing unreadable. Unreadable drafts stay put.
 */
export function movedStart({ snapshot, unreadable }: Collected): MovedStart {
  if (unreadable.length > 0) return { kind: 'unreadable' };
  const drafts = draftCount(snapshot);
  return drafts === 0 ? { kind: 'redirect' } : { kind: 'idle', drafts };
}
